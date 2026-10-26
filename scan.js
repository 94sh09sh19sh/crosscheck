// crosscheck 機械掃描：語法、殘留標記、設定與 README 不同步、沒執行就說已驗證；不花 token
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const RUN_TOOLS = /^(Bash|PowerShell)$/;
const CLAIM = /(測試|檢查)(都|全部)?(通過|沒問題)|已(實際)?(驗證|測試|跑過)|驗證(通過|過了)|tests? (all )?pass/i;
// 合併衝突標記，與模型常見的「其餘照舊」省略寫法；第三欄 true 表示只查程式檔（文件裡可能是在舉例）
const LEFTOVERS = [
  [/^(<{7}|>{7})( |$)/m, '留有合併衝突標記', false],
  [/^\s*(\/\/|#)\s*(\.{3}\s*(existing|rest of|其餘|其他|原本)|rest of (the )?(code|file)|其餘(程式|內容)?(不變|照舊|同上))/im, '留有「其餘照舊」之類的省略註解', true],
];
const DOC = /\.(md|markdown|txt|rst)$/i;

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function run(cmd, args, timeout = 10000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout });
  if (r.error) return null;
  return { ok: r.status === 0, err: (r.stderr || '').trim() };
}

const firstLine = (s) => String(s).split('\n').find((l) => /error/i.test(l)) || String(s).split('\n')[0];

// 有 JSX 的 .js 檔 node --check 會誤報，略過
const looksJsx = (t) => /return\s*\(\s*<|<\/[A-Za-z][\w.]*>|<[A-Z][\w.]*[\s/>]/.test(t);

function syntax(file, text) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      // 帶註解的 JSONC（tsconfig、VS Code 設定）不算錯
      if (/^\s*\/\/|\/\*/m.test(text)) return null;
      return `JSON 解析失敗：${e.message}`;
    }
    return null;
  }
  if (/^\.(c|m)?js$/.test(ext)) {
    if (looksJsx(text)) return null;
    const r = run(process.execPath, ['--check', file]);
    return r && !r.ok ? `語法錯誤：${firstLine(r.err)}` : null;
  }
  if (ext === '.py') {
    const r = run('python', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', file]);
    return r && !r.ok && /SyntaxError|IndentationError/.test(r.err) ? `語法錯誤：${r.err.split('\n').pop()}` : null;
  }
  return null;
}

// 同資料夾 README 已經在列 config.json 的鍵，卻漏了某些鍵：多半是加了設定沒寫文件
function configSync(file, text) {
  if (path.basename(file) !== 'config.json') return null;
  let cfg;
  try {
    cfg = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const readme = read(path.join(path.dirname(file), 'README.md'));
  if (!readme || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const keys = Object.keys(cfg);
  const missing = keys.filter((k) => !readme.includes(k));
  return missing.length && missing.length < keys.length ? `README.md 沒提到設定鍵：${missing.join('、')}` : null;
}

// 回傳 [{ file, problem }]；file 用絕對路徑
function scanFiles(files) {
  const issues = [];
  for (const file of [...new Set(files)]) {
    const text = read(file);
    if (text == null) continue;
    for (const p of [syntax(file, text), configSync(file, text), ...LEFTOVERS.map(([re, msg, code]) => (re.test(text) && !(code && DOC.test(file)) ? msg : null))]) {
      if (p && !issues.some((i) => i.file === file && i.problem === p)) issues.push({ file, problem: p });
    }
  }
  return issues;
}

// 真正的使用者訊息：不是工具結果、不是系統補的
function isUserPrompt(e) {
  if (e.type !== 'user' || e.isMeta) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result');
}

// 讀 transcript 尾端，回傳最後一則使用者訊息之後：改過的檔、有沒有執行過指令、最後一段回覆文字
function lastTurn(transcriptPath, cwd, tailBytes = 4 * 1024 * 1024) {
  let text = '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  let start = -1;
  entries.forEach((e, i) => isUserPrompt(e) && (start = i));
  if (start < 0) return null;
  const files = [];
  let ran = false;
  let reply = '';
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use' && EDIT_TOOLS.test(b.name)) {
        const f = b.input?.file_path || b.input?.notebook_path;
        if (f) files.push(path.resolve(cwd || '.', f));
      } else if (b.type === 'tool_use' && RUN_TOOLS.test(b.name)) ran = true;
      else if (b.type === 'text' && b.text) reply = b.text;
    }
  }
  return { files, ran, reply };
}

// Stop 用：這回合改了檔才掃；說已驗證卻沒執行過任何指令也算一項
function scanTurn(input) {
  const t = lastTurn(input.transcript_path, input.cwd);
  if (!t || !t.files.length) return [];
  const issues = scanFiles(t.files);
  const reply = input.last_assistant_message || t.reply;
  if (!t.ran && CLAIM.test(reply)) issues.push({ file: null, problem: '回覆說已驗證或測試通過，但這回合沒有執行過任何指令' });
  return issues;
}

module.exports = { scanFiles, scanTurn, lastTurn, isUserPrompt, CLAIM };
