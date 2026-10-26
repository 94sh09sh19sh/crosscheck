// crosscheck 測試：觸發解析、機械掃描、Stop 常駐掃描、prep 的檔位與掃描
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-test-'));
process.env.CROSSCHECK_STATE_DIR = path.join(tmp, 'state');
const L = require('./lib');
const S = require('./scan');
const HOOK = path.join(__dirname, 'hook.js');
const CLI = path.join(__dirname, 'cli.js');
const cfg = L.loadConfig();
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name}\n  ${e.message}`);
  }
}

function write(rel, text) {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

function transcript(name, entries) {
  return write(`${name}.jsonl`, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolUse = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${Math.random()}`, name, input }] } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });

function hook(input, conf = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CROSSCHECK_CONFIG_JSON: JSON.stringify(conf) } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env }).stdout;

test('觸發：%% 預設檔位 2，前後要空白', () => {
  assert.deepStrictEqual(L.parseTrigger('修好它 %%', cfg), { tier: 2, request: '修好它', sibling: false });
  assert.strictEqual(L.parseTrigger('50%% 折扣', cfg), null);
  assert.strictEqual(L.parseTrigger('a%%3', cfg), null);
});

test('觸發：舊檔位 4、5 視同 3', () => {
  assert.strictEqual(L.parseTrigger('%%5 做事', cfg).tier, 3);
  assert.strictEqual(L.parseTrigger('%%1 做事', cfg).tier, 1);
});

test('觸發：blindspot 的 ^^ 從需求原文去掉', () => {
  assert.strictEqual(L.parseTrigger('^^3 做 X %%2', cfg).request, '做 X');
  assert.strictEqual(L.parseTrigger('^^3 做 X %%2', cfg).sibling, true);
  assert.match(L.contextFor({ id: 'x', tier: 2, sibling: true, snapshot: { kind: 'git' } }), /先照它的流程走到 go/);
  assert.strictEqual(L.parseTrigger('a^^b %%', cfg).request, 'a^^b');
});

test('掃描：JSON 錯誤會報，JSONC 不報', () => {
  const bad = write('a/bad.json', '{"a": 1,}');
  const jsonc = write('a/tsconfig.json', '{\n  // 註解\n  "a": 1,\n}');
  const issues = S.scanFiles([bad, jsonc]);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].file, bad);
});

test('掃描：JS 語法錯誤會報，JSX 不報', () => {
  const bad = write('b/x.js', 'function f( {\n');
  const jsx = write('b/c.js', 'export default function C() { return (<div>hi</div>); }\n');
  const ok = write('b/ok.js', 'module.exports = 1;\n');
  const files = S.scanFiles([bad, jsx, ok]).map((i) => i.file);
  assert.deepStrictEqual(files, [bad]);
});

test('掃描：Python 語法錯誤會報', () => {
  const bad = write('c/x.py', 'def f(:\n  pass\n');
  const ok = write('c/ok.py', 'def f():\n    return 1\n');
  const files = S.scanFiles([bad, ok]).map((i) => i.file);
  assert.deepStrictEqual(files, [bad]);
});

test('掃描：衝突標記與省略註解；文件裡的省略舉例不報', () => {
  const conflict = write('d/m.txt', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n');
  const omit = write('d/o.js', 'const a = 1;\n// ... existing code ...\n');
  const doc = write('d/r.md', '例：\n// ... existing code ...\n');
  const got = S.scanFiles([conflict, omit, doc]).map((i) => path.basename(i.file));
  assert.deepStrictEqual(got, ['m.txt', 'o.js']);
});

test('掃描：README 列了設定鍵卻漏了新鍵', () => {
  const c = write('e/config.json', '{"alpha": 1, "beta": 2}');
  write('e/README.md', '- `alpha`：說明\n');
  const issues = S.scanFiles([c]);
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0].problem, /beta/);
  write('f/README.md', '這個 README 不列設定\n');
  assert.strictEqual(S.scanFiles([write('f/config.json', '{"alpha": 1}')]).length, 0);
});

test('回合：只看最後一則使用者訊息之後的改檔', () => {
  const old = write('g/old.json', '{bad');
  const now = write('g/now.json', '{"ok": true}');
  const t = transcript('g', [user('第一則'), toolUse('Write', { file_path: old }), result(), user('第二則'), toolUse('Edit', { file_path: now }), result(), say('好了')]);
  const turn = S.lastTurn(t, tmp);
  assert.deepStrictEqual(turn.files, [now]);
  assert.strictEqual(turn.ran, false);
  assert.strictEqual(turn.reply, '好了');
});

test('回合：改了檔、沒執行指令卻說測試通過', () => {
  const f = write('h/a.js', 'module.exports = 1;\n');
  const t = transcript('h1', [user('改'), toolUse('Edit', { file_path: f }), result(), say('改好了，測試全部通過。')]);
  assert.strictEqual(S.scanTurn({ transcript_path: t, cwd: tmp }).length, 1);
  const t2 = transcript('h2', [user('改'), toolUse('Edit', { file_path: f }), result(), toolUse('Bash', { command: 'npm test' }), result(), say('改好了，測試全部通過。')]);
  assert.strictEqual(S.scanTurn({ transcript_path: t2, cwd: tmp }).length, 0);
  const t3 = transcript('h3', [user('問'), say('上次已驗證過')]);
  assert.strictEqual(S.scanTurn({ transcript_path: t3, cwd: tmp }).length, 0);
});

test('Stop hook：有問題擋一次，stop_hook_active 或關閉時不擋，沒問題不輸出', () => {
  const bad = write('i/bad.json', '{bad');
  const t = transcript('i', [user('改'), toolUse('Write', { file_path: bad }), result(), say('好了')]);
  const base = { hook_event_name: 'Stop', session_id: 's-i', transcript_path: t, cwd: tmp };
  const r = hook(base);
  assert.strictEqual(r.decision, 'block');
  assert.match(r.reason, /bad\.json/);
  assert.strictEqual(hook({ ...base, stop_hook_active: true }), null);
  assert.strictEqual(hook(base, { autoScan: false }), null);
  const ok = write('i/ok.json', '{}');
  const t2 = transcript('i2', [user('改'), toolUse('Write', { file_path: ok }), result(), say('好了')]);
  assert.strictEqual(hook({ ...base, transcript_path: t2 }), null);
});

test('prep：檔位 1 不叫子代理但會掃描；檔位 2 叫 blind 與 diffcheck', () => {
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.json'), '{}');
  const j1 = L.createJob({ tier: 1, request: '改 a', cwd: proj, sessionId: 's-p1', transcriptPath: '', source: 'test' }, cfg);
  const j2 = L.createJob({ tier: 2, request: '改 a', cwd: proj, sessionId: 's-p2', transcriptPath: '', source: 'test' }, cfg);
  fs.writeFileSync(path.join(proj, 'a.json'), '{bad');
  for (const j of [j1, j2]) fs.writeFileSync(path.join(L.jobDir(j), 'handoff.md'), '## 改動檔案\n- a.json\n');
  const o1 = cli('prep', j1.id);
  assert.match(o1, /機械掃描 1 項/);
  assert.match(o1, /檔位 1 不叫子代理/);
  assert.deepStrictEqual(L.loadJob(j1.id).expect, []);
  const o2 = cli('prep', j2.id);
  assert.match(o2, /prompts\/blind\.md/);
  assert.match(o2, /prompts\/diffcheck\.md.*輪次：1/);
  assert.deepStrictEqual(L.loadJob(j2.id).expect, ['blind-b.md', 'diffcheck-1.md']);
  cli('cancel', 'all');
});

test('工作目錄：放在專案的 .crosscheck，git 看不到、不進 diff，取消後搬回 state 並清掉', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const job = L.createJob({ tier: 1, request: '改 a', cwd: repo, sessionId: 's-r', transcriptPath: '', source: 'test' }, cfg);
  assert.strictEqual(path.dirname(job.work), path.join(repo, '.crosscheck'));
  assert.ok(fs.existsSync(path.join(job.work, 'request.md')));
  assert.ok(fs.existsSync(path.join(job.work, 'meta.json')));
  assert.strictEqual(g('status', '--porcelain').stdout.trim(), '');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2\n');
  fs.writeFileSync(path.join(job.work, 'handoff.md'), '## 改動檔案\n- a.txt\n');
  cli('prep', job.id);
  const diff = fs.readFileSync(path.join(job.work, 'diff.patch'), 'utf8');
  assert.match(diff, /a\.txt/);
  assert.doesNotMatch(diff, /\.crosscheck|handoff/);
  cli('cancel', job.id);
  assert.ok(!fs.existsSync(path.join(repo, '.crosscheck')));
  assert.ok(fs.existsSync(path.join(L.stateDir(job.id), 'work', 'handoff.md')));
});

test('Stop hook：job 未完成時擋一次，在等背景工作時不擋', () => {
  const job = L.createJob({ tier: 2, request: 'x', cwd: tmp, sessionId: 's-w', transcriptPath: '', source: 'test' }, cfg);
  const base = { hook_event_name: 'Stop', session_id: 's-w', cwd: tmp };
  assert.strictEqual(hook({ ...base, background_tasks: [{ id: 'b', type: 'local_agent', status: 'running' }] }), null);
  assert.strictEqual(hook(base).decision, 'block');
  assert.strictEqual(L.loadJob(job.id).blocks, 1);
  cli('cancel', 'all');
});

test('Stop hook：job 進行中不跑常駐掃描', () => {
  const proj = path.join(tmp, 'proj2');
  fs.mkdirSync(proj, { recursive: true });
  const bad = write('proj2/bad.json', '{bad');
  const job = L.createJob({ tier: 2, request: 'x', cwd: proj, sessionId: 's-j', transcriptPath: '', source: 'test' }, cfg);
  job.phase = 'review';
  job.expect = ['blind-b.md'];
  L.saveJob(job);
  const t = transcript('j', [user('改'), toolUse('Write', { file_path: bad }), result(), say('好了')]);
  assert.strictEqual(hook({ hook_event_name: 'Stop', session_id: 's-j', transcript_path: t, cwd: proj }), null);
  cli('cancel', 'all');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} 個失敗` : '全部通過');
process.exit(failed ? 1 : 0);
