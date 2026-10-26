// crosscheck（粗心檢查）共用函式：路徑、設定、觸發解析、job 建立、快照、diff、token 統計
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
// CROSSCHECK_STATE_DIR 只給測試用，避免弄髒正式狀態
const STATE = process.env.CROSSCHECK_STATE_DIR || path.join(ROOT, 'state');
const DIRS = {
  jobs: path.join(STATE, 'jobs'),
  sessions: path.join(STATE, 'sessions'),
  debug: path.join(STATE, 'debug'),
};
const LOG_FILE = path.join(STATE, 'crosscheck.log');
const HISTORY_FILE = path.join(STATE, 'history.jsonl');
const ITER_CHAIN_DIR = path.join(os.homedir(), '.claude', 'iter-chain');

const DEFAULT_CONFIG = {
  enabled: true,
  trigger: '%%',
  defaultTier: 2,
  keepAliveSec: 3000,
  snapshotMaxMB: 200,
  snapshotMaxFiles: 20000,
  snapshotTimeoutSec: 20,
  snapshotExclude: ['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage', 'target', '.iter-chain'],
  stopBlockMax: 1,
  autoScan: true,
  stripTokens: ['^^'],
  outputWeight: 5,
  debug: false,
};

// 各檔位第一批要叫出的子代理與修正輪數上限；檔位 1 只有機械掃描與主對話自查
// diffcheck 跑兩次是刻意的：同一份清單獨立再掃一次，比換角度更能抓到粗心
const MAX_TIER = 3;
const TIERS = {
  1: { agents: [], fixRounds: 1 },
  2: { agents: [{ name: 'blind', out: 'blind-b.md' }, { name: 'diffcheck', out: 'diffcheck-1.md', extra: '輪次：1。' }], fixRounds: 1 },
  3: { agents: [{ name: 'blind', out: 'blind-b.md' }, { name: 'diffcheck', out: 'diffcheck-1.md', extra: '輪次：1。' }, { name: 'diffcheck', out: 'diffcheck-2.md', extra: '輪次：2。' }], fixRounds: 2 },
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免多個 hook 同時寫入時讀到半個檔案
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  // CROSSCHECK_CONFIG_JSON 只給測試用，可以臨時覆寫設定
  let env = {};
  try {
    env = JSON.parse(process.env.CROSSCHECK_CONFIG_JSON || '{}');
  } catch {}
  // config.json 是 repo 的預設值；config.local.json 是本機個人設定，部署不會覆蓋
  return { ...DEFAULT_CONFIG, ...readJson(path.join(ROOT, 'config.json'), {}), ...readJson(path.join(ROOT, 'config.local.json'), {}), ...env };
}

function log(msg) {
  try {
    ensureDirs();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const slash = (p) => String(p).split(path.sep).join('/');
const jobDir = (id) => path.join(DIRS.jobs, id);
const metaFile = (id) => path.join(jobDir(id), 'meta.json');
const sessionFile = (sid) => path.join(DIRS.sessions, `${sid}.json`);
const loadJob = (id) => (id ? readJson(metaFile(id)) : null);

function saveJob(job) {
  job.updatedAt = Date.now();
  writeJson(metaFile(job.id), job);
}

function listJobs() {
  try {
    return fs.readdirSync(DIRS.jobs).map((d) => readJson(metaFile(d))).filter(Boolean);
  } catch {
    return [];
  }
}

function jobOfSession(sid) {
  const s = sid && readJson(sessionFile(sid));
  return s ? loadJob(s.jobId) : null;
}

// 跟 iter-chain 並用時只看第一段；分隔字串從 iter-chain 的設定讀
function firstSegment(prompt) {
  const ic = { ...readJson(path.join(ITER_CHAIN_DIR, 'config.json'), {}), ...readJson(path.join(ITER_CHAIN_DIR, 'config.local.json'), {}) };
  const delim = ic.enabled === false ? '' : ic.delimiter || ';;;';
  const i = delim ? prompt.indexOf(delim) : -1;
  return i >= 0 ? prompt.slice(0, i) : prompt;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 找觸發字串：前後必須是空白或字串頭尾，`%%i`、`50%%`、`a%%3` 都不算；有多個時取第一個
// 舊檔位 4、5 視同 3；stripTokens 是其他工具的觸發字串（例：blindspot 的 ^^），一併從需求原文去掉
function parseTrigger(text, cfg) {
  const m = new RegExp(`(^|\\s)${escRe(cfg.trigger)}([1-5])?(?=\\s|$)`).exec(String(text));
  if (!m) return null;
  const start = m.index + m[1].length;
  const end = start + cfg.trigger.length + (m[2] ? 1 : 0);
  let rest = `${text.slice(0, start)}${text.slice(end)}`;
  let sibling = false;
  for (const t of cfg.stripTokens || []) {
    const re = new RegExp(`(^|\\s)${escRe(t)}[1-5]?(?=\\s|$)`, 'g');
    sibling = sibling || re.test(rest);
    rest = rest.replace(re, '$1');
  }
  rest = rest.replace(/[ \t]{2,}/g, ' ').trim();
  return { tier: Math.min(m[2] ? Number(m[2]) : cfg.defaultTier, MAX_TIER), request: rest, sibling };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

const git = (cwd, args, opts = {}) => run('git', ['-c', 'core.quotepath=false', ...args], { cwd, ...opts });

function gitTop(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok && r.out ? path.resolve(r.out) : null;
}

// 用暫時的 index 檔把工作目錄（含未追蹤、未暫存的改動）寫成 tree；不動使用者的 index
function gitTree(repo, tmpIndex, timeoutMs) {
  const idx = git(repo, ['rev-parse', '--git-path', 'index']);
  const real = idx.ok ? path.resolve(repo, idx.out) : null;
  try {
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmpIndex);
  } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const add = git(repo, ['add', '-A'], { env, timeout: timeoutMs });
  if (!add.ok) throw new Error(`git add 失敗：${add.err.slice(0, 200)}`);
  const tree = git(repo, ['write-tree'], { env });
  try {
    fs.unlinkSync(tmpIndex);
  } catch {}
  if (!tree.ok) throw new Error(`git write-tree 失敗：${tree.err.slice(0, 200)}`);
  return tree.out;
}

function gitCommit(repo, tree, msg) {
  const head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'crosscheck', GIT_AUTHOR_EMAIL: 'crosscheck@localhost', GIT_COMMITTER_NAME: 'crosscheck', GIT_COMMITTER_EMAIL: 'crosscheck@localhost' };
  const r = git(repo, ['commit-tree', tree, ...(head.ok && head.out ? ['-p', head.out] : []), '-m', msg], { env });
  if (!r.ok) throw new Error(`git commit-tree 失敗：${r.err.slice(0, 200)}`);
  return r.out;
}

// 列出非 git 資料夾的檔案；超過上限或時間就丟錯
function walk(root, cfg, deadline = Infinity) {
  const skip = new Set(cfg.snapshotExclude);
  const files = [];
  let bytes = 0;
  const maxBytes = cfg.snapshotMaxMB * 1024 * 1024;
  const stack = [''];
  while (stack.length) {
    if (Date.now() > deadline) throw new Error('列出檔案逾時');
    const rel = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) {
        const size = fs.statSync(path.join(root, r)).size;
        bytes += size;
        files.push(r);
        if (files.length > cfg.snapshotMaxFiles) throw new Error(`檔案超過 ${cfg.snapshotMaxFiles} 個`);
        if (bytes > maxBytes) throw new Error(`大小超過 ${cfg.snapshotMaxMB} MB`);
      }
    }
  }
  return files;
}

function copyTree(src, dest, cfg, deadline) {
  const files = walk(src, cfg, deadline);
  for (const f of files) {
    if (Date.now() > deadline) throw new Error('複製逾時');
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
  }
  return files.length;
}

// 存下目前狀態：git 存成 commit，其他資料夾複製一份；name 是 job 目錄底下的名稱
function capture(job, name, cfg, timeoutMs) {
  const dir = jobDir(job.id);
  const repo = gitTop(job.cwd);
  if (repo) {
    const tree = gitTree(repo, path.join(dir, `${name}.index`), timeoutMs);
    return { kind: 'git', repo, sha: gitCommit(repo, tree, `crosscheck ${job.id} ${name}`) };
  }
  const dest = path.join(dir, name);
  try {
    const n = copyTree(job.cwd, dest, cfg, Date.now() + timeoutMs);
    return { kind: 'copy', dir: dest, files: n };
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

// hook 呼叫：建立 job、存原始需求、做快照、記住 session
function createJob({ tier, request, cwd, sessionId, transcriptPath, source, timeoutMs, sibling = false }, cfg) {
  ensureDirs();
  const id = `cc${Date.now().toString(36)}`;
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.md'), `${request}\n`);
  const job = { id, tier, cwd, sessionId, transcriptPath, source, sibling, status: 'running', phase: 'work', blocks: 0, fixRounds: 0, expect: [], startedAt: Date.now() };
  const t0 = Date.now();
  try {
    job.snapshot = capture(job, 'snapshot', cfg, timeoutMs ?? cfg.snapshotTimeoutSec * 1000);
  } catch (e) {
    job.snapshot = { kind: 'none', reason: String(e.message || e) };
  }
  saveJob(job);
  writeJson(sessionFile(sessionId), { jobId: id });
  log(`[${id}] 建立 job，檔位 ${tier}，來源 ${source}，快照 ${job.snapshot.kind}${job.snapshot.reason ? `（${job.snapshot.reason}）` : ''}，${Date.now() - t0} ms，${cwd}`);
  return job;
}

// 注入主對話的短指令（hook 與 iter-chain 共用）
function contextFor(job) {
  const lines = [
    `[crosscheck] 本則指令啟用粗心檢查，檔位 ${job.tier}，job ${job.id}（${slash(jobDir(job.id))}）。觸發字串 %%${job.tier} 是指令，不是需求內容。`,
    `先照常完成任務，不要因此改變做法；完成後讀 ${slash(path.join(ROOT, 'playbook.md'))} 照做，跑完 done 之前不要結束回覆。`,
  ];
  if (job.sibling) lines.push('同一則訊息也啟用了 blindspot：先照它的流程走到 go 再實作，實作完再回來跑本流程。');
  if (job.snapshot?.kind === 'none') lines.push(`注意：沒有改動前快照（${job.snapshot.reason}），盲測只依原始需求，不得讀改動前程式碼。`);
  return lines.join('\n');
}

// git diff --no-index 的標頭是兩邊的絕對路徑，改成跟 git repo 一樣的 a/相對路徑、b/相對路徑
function relHeader(out, rel, a, b) {
  const lines = out.split('\n');
  const body = lines.findIndex((l) => l.startsWith('@@') || l.startsWith('Binary'));
  const head = (body < 0 ? lines : lines.slice(0, body)).filter((l) => !/^(diff --git|--- |\+\+\+ )/.test(l));
  return [`diff --git a/${rel} b/${rel}`, ...head, `--- ${a ? `a/${rel}` : '/dev/null'}`, `+++ ${b ? `b/${rel}` : '/dev/null'}`, ...(body < 0 ? [] : lines.slice(body))].join('\n');
}

// iter-chain 的 SessionStart 呼叫：本輪指令含觸發字串就建立 job，回傳要附加的注入文字；沒有就回傳空字串
function fromIterChain(input, instruction) {
  const cfg = loadConfig();
  const t = cfg.enabled && parseTrigger(String(instruction || ''), cfg);
  if (!t || !input.cwd || !input.session_id) return '';
  // iter-chain 的 SessionStart hook 逾時是 30 秒，快照最多給 15 秒；逾時的話整段注入（含本輪指令）都會遺失
  const job = createJob({ tier: t.tier, request: t.request, cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path, source: 'iter-chain', timeoutMs: 15000, sibling: t.sibling }, cfg);
  return contextFor(job);
}

// iter-chain 限額接手時呼叫：原 session 的 job 還在跑就改由新 session 接續，回傳要附加的注入文字；沒有就回傳空字串
function handOver(oldSid, input) {
  const job = jobOfSession(oldSid);
  if (!job || job.status !== 'running' || !input.session_id) return '';
  job.blocks = 0;
  job.handovers = [...(job.handovers || []), { sessionId: input.session_id, transcriptPath: input.transcript_path, at: Date.now() }];
  saveJob(job);
  writeJson(sessionFile(input.session_id), { jobId: job.id });
  log(`[${job.id}] 限額接手：改由 session ${String(input.session_id).slice(0, 8)} 接續（階段 ${job.phase}）`);
  return `${contextFor(job)}\n這個 job 是從因限額中斷的 session 接手，目前階段 ${job.phase}；已做過的步驟（handoff、prep、已叫出的子代理、修正）不要重做，看 job 目錄裡已有的檔案從目前進度接著照 playbook 做。`;
}

// 某個狀態和目前工作目錄的差異，寫成 patch 檔；回傳行數
function writeDiff(job, base, outFile, cfg) {
  let text = '';
  if (base.kind === 'git') {
    const cur = gitTree(base.repo, path.join(jobDir(job.id), 'now.index'), cfg.snapshotTimeoutSec * 3000);
    text = git(base.repo, ['diff', '--no-color', base.sha, cur]).out;
  } else if (base.kind === 'copy') {
    const before = new Set(walk(base.dir, cfg));
    const after = new Set(walk(job.cwd, cfg));
    const parts = [];
    for (const f of [...new Set([...before, ...after])].sort()) {
      const a = before.has(f) ? path.join(base.dir, f) : null;
      const b = after.has(f) ? path.join(job.cwd, f) : null;
      if (a && b && fs.readFileSync(a).equals(fs.readFileSync(b))) continue;
      const r = run('git', ['diff', '--no-index', '--no-color', a || '/dev/null', b || '/dev/null']);
      parts.push(r.out ? relHeader(r.out, slash(f), a, b) : `檔案 ${slash(f)} ${a ? (b ? '有改動' : '已刪除') : '新增'}`);
    }
    text = parts.join('\n');
  } else {
    text = '（沒有快照，無法產生 diff）';
  }
  fs.writeFileSync(outFile, `${text}\n`);
  return text ? text.split('\n').length : 0;
}

// diff.patch 裡改動後還存在的檔案（絕對路徑），給機械掃描用
function changedFiles(job) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(jobDir(job.id), 'diff.patch'), 'utf8');
  } catch {
    return [];
  }
  const base = job.snapshot?.kind === 'git' ? job.snapshot.repo : job.cwd;
  return [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => path.join(base, m[1].trim()));
}

// 快照的 worktree（git）或複製目錄；讓子代理讀改動前的檔案
function bindSnapshot(job) {
  const s = job.snapshot;
  if (s.kind === 'copy') return s.dir;
  if (s.kind !== 'git') return null;
  const wt = path.join(jobDir(job.id), 'snap-wt');
  if (!fs.existsSync(wt)) {
    const r = git(s.repo, ['worktree', 'add', '--detach', wt, s.sha]);
    if (!r.ok) throw new Error(`git worktree add 失敗：${r.err.slice(0, 200)}`);
  }
  s.worktree = wt;
  return wt;
}

function unbindSnapshot(job) {
  const s = job.snapshot;
  if (s?.kind !== 'git' || !s.worktree) return;
  git(s.repo, ['worktree', 'remove', '--force', s.worktree]);
  git(s.repo, ['worktree', 'prune']);
  fs.rmSync(s.worktree, { recursive: true, force: true });
  delete s.worktree;
}

// 讀 transcript，同一個 message.id 會重複出現在每個內容區塊，只算一次
function readUsage(file, filter = () => true) {
  const msgs = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'assistant' || !e.message?.usage || !filter(e)) continue;
    msgs.set(e.message.id || e.uuid, { ts: Date.parse(e.timestamp), model: e.message.model, effort: e.effort, usage: e.message.usage });
  }
  return [...msgs.values()];
}

function sumUsage(list, cfg) {
  const t = { calls: list.length, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, output: 0 };
  for (const { usage: u } of list) {
    t.input += u.input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.output += u.output_tokens || 0;
    const cc = u.cache_creation;
    if (cc) {
      t.cache5m += cc.ephemeral_5m_input_tokens || 0;
      t.cache1h += cc.ephemeral_1h_input_tokens || 0;
    } else t.cache5m += u.cache_creation_input_tokens || 0;
  }
  // API 計價口徑：輸入 1、快取讀 0.1、5 分鐘快取寫 1.25、1 小時快取寫 2、輸出依設定（預設 5）
  t.weighted = Math.round(t.input + t.cacheRead * 0.1 + t.cache5m * 1.25 + t.cache1h * 2 + t.output * cfg.outputWeight);
  return t;
}

// 主對話：觸發到 prep 之間算 C，prep 之後算額外成本；子代理：prompt 含 job id 的 Agent 呼叫
// 限額接手過的 job 要把原 session 和各接手 session 的 transcript 都算進來
function usageOf(job, cfg) {
  const end = job.doneAt || Date.now();
  const cut = job.prepAt || end;
  const sources = [{ sessionId: job.sessionId, transcriptPath: job.transcriptPath }, ...(job.handovers || [])];
  const main = [];
  const agents = [];
  const toolIds = new Set();
  for (const s of sources) {
    main.push(...readUsage(s.transcriptPath, (e) => {
      const ts = Date.parse(e.timestamp);
      return ts >= job.startedAt && ts <= end;
    }));
    try {
      for (const line of fs.readFileSync(s.transcriptPath, 'utf8').split('\n')) {
        if (!line.includes(job.id) || !line.includes('"tool_use"')) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        for (const c of e.message?.content || []) if (c.type === 'tool_use' && /^(Agent|Task)$/.test(c.name) && JSON.stringify(c.input).includes(job.id)) toolIds.add(c.id);
      }
    } catch {}
    const subDir = path.join(path.dirname(s.transcriptPath || ''), s.sessionId, 'subagents');
    let metas = [];
    try {
      metas = fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json'));
    } catch {}
    for (const f of metas) {
      const m = readJson(path.join(subDir, f), {});
      if (!toolIds.has(m.toolUseId)) continue;
      const list = readUsage(path.join(subDir, f.replace(/\.meta\.json$/, '.jsonl')));
      const u = sumUsage(list, cfg);
      u.description = m.description;
      u.models = [...new Set(list.map((x) => x.model).filter(Boolean))].join(',');
      u.efforts = [...new Set(list.map((x) => x.effort).filter(Boolean))].join(',');
      agents.push(u);
    }
  }
  const res = { C: sumUsage(main.filter((m) => m.ts < cut), cfg), mainExtra: sumUsage(main.filter((m) => m.ts >= cut), cfg), agents };
  res.extra = res.mainExtra.weighted + res.agents.reduce((s, a) => s + a.weighted, 0);
  res.ratio = res.C.weighted ? +(res.extra / res.C.weighted).toFixed(2) : null;
  res.toolUses = toolIds.size;
  return res;
}

// 帳本每個發現一行：「- F1｜成立｜已修｜…」；只數狀態欄
function ledgerStats(job) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(jobDir(job.id), 'ledger.md'), 'utf8');
  } catch {}
  const rows = text.split('\n').filter((l) => /^-\s*F\d+/.test(l));
  const has = (w) => rows.filter((l) => l.includes(w)).length;
  return { findings: rows.length, fixed: has('已修'), rejected: has('駁回'), open: has('未解決') + has('待使用者') };
}

module.exports = {
  ROOT, STATE, DIRS, LOG_FILE, HISTORY_FILE, DEFAULT_CONFIG, TIERS, MAX_TIER,
  ensureDirs, readJson, writeJson, loadConfig, log, readStdin, slash,
  jobDir, metaFile, sessionFile, loadJob, saveJob, listJobs, jobOfSession,
  firstSegment, parseTrigger, createJob, contextFor, fromIterChain, handOver, capture, writeDiff, changedFiles, bindSnapshot, unbindSnapshot,
  usageOf, ledgerStats,
};
