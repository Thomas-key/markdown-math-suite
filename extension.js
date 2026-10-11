const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let expanding = false;

// ── 内置规则表：同目录的 rules.jsonc（支持注释和尾随逗号）──
const RULES_FILE = path.join(__dirname, 'rules.jsonc');
let builtinRules = { inMath: {}, outMath: {}, inMathRegex: {}, outMathRegex: {} };

function parseJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {                                  // 字符串内部：原样拷贝，处理 \" 转义
      out += c; i++;
      if (c === '\\') { out += text[i] || ''; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {        // // 行注释
      i += 2; while (i < text.length && text[i] !== '\n') i++; continue;
    }
    if (c === '/' && text[i + 1] === '*') {        // /* */ 块注释
      i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue;
    }
    if (c === ',') {                               // 尾随逗号：后面只剩 } 或 ] 就丢掉
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
    }
    out += c; i++;
  }
  return JSON.parse(out);
}

function loadBuiltinRules() {
  try {
    const r = parseJsonc(fs.readFileSync(RULES_FILE, 'utf8'));
    builtinRules = {
      inMath: r.inMath || {},
      outMath: r.outMath || {},
      inMathRegex: r.inMathRegex || {},
      outMathRegex: r.outMathRegex || {},
    };
  } catch (e) {
    vscode.window.showErrorMessage('Markdown Math Suite: rules.jsonc 读取失败 — ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  数学环境判定
//
//  三种状态：
//    MODE_TEXT     不在数学里
//    MODE_INLINE   在 $ … $ 里
//    MODE_DISPLAY  在 $$ … $$ 里（这种 $$ 必须独占一行）
//  另有 IN_CODE：在 ``` / ~~~ 围栏代码块里 —— 那里不算数学，也不展开。
//
//  缓存 mcache 记的是「第 line 行行首」的状态；判新位置时从缓存行往下推进，
//  不用每次从头扫。任何发生在缓存行之前的改动都会让它作废（见 activate）。
// ══════════════════════════════════════════════════════════════
const MODE_TEXT = 0, MODE_INLINE = 1, MODE_DISPLAY = 2, IN_CODE = null;

let mcache = null;   // { doc, line, offset, mode, fence }

// 这一行是不是围栏行（行首 ≤3 空格 + 3 个以上的 ` 或 ~）？返回 {ch, n} 或 null
function fenceStart(lineText) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(lineText);
  return m ? { ch: m[1][0], n: m[1].length } : null;
}

// 扫一行里的 $，返回扫完后的状态。end = 扫到第几列为止（不含该列）
function scanDollars(lineText, end, mode) {
  const wholeLineIsDollars = /^\${2,}$/.test(lineText.trim());   // 整行只有 $$ → 行间公式分隔符
  let i = 0;
  while (i < end) {
    const c = lineText[i];
    if (c !== '$' || (i > 0 && lineText[i - 1] === '\\')) { i++; continue; }   // \$ 不算分隔符
    let n = 0;
    while (lineText[i + n] === '$') n++;                        // 数连续的 $
    if (wholeLineIsDollars && lineText.slice(0, i).trim() === '') {
      if (mode === MODE_TEXT) mode = MODE_DISPLAY;              // $$ 独占一行 → 行间公式开
      else if (mode === MODE_DISPLAY) mode = MODE_TEXT;         // $$ 独占一行 → 行间公式关
    } else {
      // 其余情况的 $ 一律按"单个 $ 开关行内公式"处理。
      // 所以同一行里连着两个 $ 正好开关两次、净效果为零 —— 它不构成行间公式。
      for (let k = 0; k < n; k++) {
        if (mode === MODE_TEXT) mode = MODE_INLINE;
        else if (mode === MODE_INLINE) mode = MODE_TEXT;
      }
    }
    i += n;
  }
  return mode;
}

// 整行推进（更新缓存里的状态）
function advanceLine(lineText, st) {
  const info = fenceStart(lineText);
  if (st.fence) {                                               // 在围栏里：$ 不算，等同款收尾就出去
    if (info && info.ch === st.fence.ch && info.n >= st.fence.n) st.fence = null;
    return;
  }
  if (info) { st.fence = info; return; }                        // 开围栏这一行也不扫
  st.mode = scanDollars(lineText, lineText.length, st.mode);
}

// 只算到第 character 列（不改缓存）
function modeInLine(lineText, character, st) {
  if (st.fence || fenceStart(lineText)) return IN_CODE;
  return scanDollars(lineText, character, st.mode);
}

function mathMode(doc, pos) {
  if (!mcache || mcache.doc !== doc || mcache.line > pos.line) {
    mcache = { doc, line: 0, offset: 0, mode: MODE_TEXT, fence: null };  // 换文档 / 光标回到更早的行 → 从头
  }
  for (let ln = mcache.line; ln < pos.line; ln++) advanceLine(doc.lineAt(ln).text, mcache);
  mcache.line = pos.line;
  mcache.offset = doc.offsetAt(new vscode.Position(pos.line, 0));
  return modeInLine(doc.lineAt(pos.line).text, pos.character, mcache);
}

// ── 判断函数(词尾匹配) ──
function matchRule(line, rules) {
  let best = null;
  for (const [trigger, replacement] of Object.entries(rules)) {
    if (line.endsWith(trigger) && (!best || trigger.length > best.trigger.length)) {
      best = { trigger, replacement };
    }
  }
  return best;
}

function matchRegexRule(line, rules) {
  let best = null;
  for (const [pattern, template] of Object.entries(rules)) {
    const m = line.match(pattern);
    if (m && (!best || m[0].length > best.trigger.length)) {
      best = {
        trigger: m[0],
        replacement: template.replace(/\{(\d+)\}/g, (_, n) => m[+n] || ''),
      };
    }
  }
  return best;
}

// ── 块级规则：替换内容以换行开头。触发词本来就在行首时，去掉这个换行 ──
function dropBlockNewline(replacement, doc, triggerStart) {
  if (!replacement.startsWith('\n')) return replacement;
  if (triggerStart === 0) return replacement.slice(1);
  const prev = doc.getText(new vscode.Range(doc.positionAt(triggerStart - 1), doc.positionAt(triggerStart)));
  return prev === '\n' ? replacement.slice(1) : replacement;
}

// ── 交给 insertSnippet 之前的一层处理 ──
// snippet 解析器只把 \$ \} \\ 当转义，会吃掉反斜杠。规则表里写的是纯 LaTeX，
// 所以这里先把「后面不是跟 $ 的反斜杠」翻倍，解析后正好还原成原样。
function toSnippet(text) {
  return text.replace(/\\(?![$])/g, '\\\\');
}

// ── 替换函数 ──
function applyReplacement(editor, pos, trigger, replacement) {
  const range = new vscode.Range(pos.translate(0, -trigger.length), pos);
  return editor
    .edit((eb) => eb.delete(range), { undoStopBefore: false, undoStopAfter: false })
    .then(() =>
      vscode.commands.executeCommand('editor.action.insertSnippet', {
        snippet: toSnippet(replacement),
      })
    );
}

function activate(context) {
  loadBuiltinRules();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      // 任何改动都可能让缓存作废，所以放在所有提前 return 之前
      if (mcache && mcache.doc === e.document) {
        const cs = e.contentChanges;
        if (cs.length !== 1 || e.document.offsetAt(cs[0].range.start) < mcache.offset) {
          mcache = null;      // 多光标 / 批量改动 / 改在缓存行之前 → 丢掉，下次从头
        }
      }
      if (e.document.languageId !== 'markdown') return;

      const c = e.contentChanges[0];
      if (!c || c.text.length !== 1) return;

      const pos = c.range.start.translate(0, c.text.length);
      const line = e.document.lineAt(pos.line).text.slice(0, pos.character);

      if (expanding) return;

      const cfg = vscode.workspace.getConfiguration('mdMathSuite');
      const inRules = { ...builtinRules.inMath, ...cfg.get('inMathRules', {}) };
      const outRules = { ...builtinRules.outMath, ...cfg.get('outMathRules', {}) };
      const reIn = { ...builtinRules.inMathRegex, ...cfg.get('inMathRegexRules', {}) };
      const reOut = { ...builtinRules.outMathRegex, ...cfg.get('outMathRegexRules', {}) };

      const reInHit = matchRegexRule(line, reIn);
      const reOutHit = matchRegexRule(line, reOut);
      const inHit = matchRule(line, inRules);
      const outHit = matchRule(line, outRules);
      if (!reInHit && !reOutHit && !inHit && !outHit) return;

      const mode = mathMode(e.document, pos);            // ← 判断
      if (mode === IN_CODE) return;                      // 代码块里不展开
      const hit = (mode !== MODE_TEXT) ? (reInHit || inHit) : (reOutHit || outHit);
      if (!hit) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document !== editor.document) return;

      const triggerStart = e.document.offsetAt(pos.translate(0, -hit.trigger.length));
      const replacement = dropBlockNewline(hit.replacement, e.document, triggerStart);

      expanding = true;
      applyReplacement(editor, pos, hit.trigger, replacement)      // ← 替换
        .finally(() => { expanding = false; });
    })
  );
}
function deactivate() { }
module.exports = { activate, deactivate };
