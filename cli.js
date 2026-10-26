// crosscheck 管理指令：主對話照 playbook 呼叫 prep、wait、fix-start、fix-end、usage、done；使用者用 status、log、cancel、clean
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const S = require('./scan');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const maxSec = Number(flag('--max', 0));
const [cmd = 'status', arg, ...rest] = argv;
const cfg = L.loadConfig();
const when = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '-');
const CLI = L.slash(path.join(L.ROOT, 'cli.js'));
const prompt = (name) => L.slash(path.join(L.ROOT, 'prompts', `${name}.md`));

function need() {
  const job = L.loadJob(arg);
  if (!job) {
    console.log(`找不到 job ${arg}`);
    process.exit(1);
  }
  return job;
}

function agentLine(job, name, extra = '') {
  return `- description「crosscheck ${name}」，prompt：讀 ${prompt(name)} 照做。job 目錄：${L.slash(L.jobDir(job.id))}。檔位：${job.tier}。${extra}`;
}

const AGENT_RULE = '叫法：subagent_type general-purpose，effort "high"，不傳 model；能選背景執行就選背景。';

// 移除大型複本（非 git 快照、修正前檢查點），保留文字紀錄
function dropCopies(job) {
  L.unbindSnapshot(job);
  const dir = L.jobDir(job.id);
  for (const d of fs.readdirSync(dir)) {
    if (d === 'snapshot' || /^pre-fix-\d+$/.test(d)) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  }
}

// handoff 寫完後呼叫：記下 C 的分界、準備快照目錄與 diff、印出要叫的子代理
function prep() {
  const job = need();
  const dir = L.jobDir(job.id);
  if (!fs.existsSync(path.join(dir, 'handoff.md'))) return console.log(`還沒有 ${L.slash(path.join(dir, 'handoff.md'))}，先照 playbook 寫好再執行 prep`);
  if (!job.prepAt) job.prepAt = Date.now();
  job.phase = 'review';
  let snap = null;
  try {
    snap = L.bindSnapshot(job);
  } catch (e) {
    job.snapshot.bindError = String(e.message || e);
  }
  job.snapPath = snap;
  const lines = L.writeDiff(job, job.snapshot, path.join(dir, 'diff.patch'), cfg);
  const issues = S.scanFiles(L.changedFiles(job));
  fs.writeFileSync(path.join(dir, 'scan.md'), `${issues.map((i) => `- ${L.slash(i.file)}｜${i.problem}`).join('\n') || '無'}\n`);
  const agents = L.TIERS[job.tier].agents;
  job.expect = agents.map((a) => a.out);
  L.saveJob(job);
  L.log(`[${job.id}] prep：快照 ${snap ? L.slash(snap) : '無'}，diff ${lines} 行，掃描 ${issues.length} 項，子代理 ${agents.map((a) => a.out).join('、') || '無'}`);
  console.log(`job ${job.id}｜檔位 ${job.tier}｜快照 ${snap ? L.slash(snap) : `無（${job.snapshot.reason || job.snapshot.bindError}）`}｜diff ${L.slash(path.join(dir, 'diff.patch'))}（${lines} 行）`);
  console.log(issues.length ? `機械掃描 ${issues.length} 項（${L.slash(path.join(dir, 'scan.md'))}），直接列入帳本：\n${issues.map((i) => `- ${L.slash(i.file)}｜${i.problem}`).join('\n')}` : '機械掃描：無');
  if (!agents.length) return console.log(`檔位 1 不叫子代理：照 playbook「自查」一節自己做，接著記帳本`);
  console.log(`請在同一回合平行叫出以下子代理。${AGENT_RULE}`);
  for (const a of agents) console.log(agentLine(job, a.name, a.extra));
  console.log(`叫出後用 Bash 背景執行（run_in_background）：node ${CLI} wait ${job.id}`);
}

// 等到預期產出都出現、job 被取消、或到時間；給主對話當保溫計時
async function wait() {
  let job = need();
  if (rest.length) {
    job.expect = rest;
    L.saveJob(job);
  }
  const dir = L.jobDir(job.id);
  const limit = Date.now() + (maxSec || cfg.keepAliveSec) * 1000;
  for (;;) {
    job = L.loadJob(job.id);
    const missing = job.expect.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (job.status !== 'running') return console.log(`job 狀態是 ${job.status}，停止等待`);
    if (!missing.length) return console.log(`產出都到了：${job.expect.join('、')}`);
    if (Date.now() > limit) return console.log(`到時間，還缺 ${missing.join('、')}；子代理還在跑就再背景執行一次 wait`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function fixStart() {
  const job = need();
  const n = job.fixRounds + 1;
  const cap = L.TIERS[job.tier].fixRounds;
  if (n > cap) return console.log(`已達檔位 ${job.tier} 的修正上限 ${cap} 輪；剩下的問題列入回報，不要再修`);
  if (job.snapshot.kind === 'none') job.checkpoint = { kind: 'none' };
  else {
    try {
      job.checkpoint = L.capture(job, `pre-fix-${n}`, cfg, cfg.snapshotTimeoutSec * 3000);
    } catch (e) {
      job.checkpoint = { kind: 'none', reason: String(e.message || e) };
    }
  }
  job.checkpoint.n = n;
  L.saveJob(job);
  console.log(`第 ${n} 輪修正開始（上限 ${cap} 輪）；修完、重跑相關測試後執行：node ${CLI} fix-end ${job.id}`);
}

function fixEnd() {
  const job = need();
  if (!job.checkpoint) return console.log(`還沒執行 fix-start ${job.id}`);
  const n = job.checkpoint.n;
  const file = path.join(L.jobDir(job.id), `fix-${n}.patch`);
  const lines = L.writeDiff(job, job.checkpoint, file, cfg);
  job.fixRounds = n;
  delete job.checkpoint;
  fs.rmSync(path.join(L.jobDir(job.id), `pre-fix-${n}`), { recursive: true, force: true });
  if (job.tier >= 3) job.expect = [`recheck-${n}.md`];
  L.saveJob(job);
  console.log(`第 ${n} 輪修正的 diff：${L.slash(file)}（${lines} 行）`);
  if (job.tier < 3) return console.log('檔位 1–2 不叫複查子代理；接著執行 usage 與 done');
  console.log(`叫出複查子代理。${AGENT_RULE}`);
  console.log(agentLine(job, 'recheck', `修正輪次：${n}。`));
  console.log(`叫出後背景執行：node ${CLI} wait ${job.id}`);
}

function fmt(u) {
  return `加權 ${u.weighted}｜輸入 ${u.input}｜快取讀 ${u.cacheRead}｜快取寫 ${u.cache5m}+${u.cache1h}(1h)｜輸出 ${u.output}｜${u.calls} 次`;
}

function usage(print = true) {
  const job = need();
  const u = L.usageOf(job, cfg);
  L.writeJson(path.join(L.jobDir(job.id), 'usage.json'), u);
  if (!print) return u;
  console.log(`C（觸發到 prep）：${fmt(u.C)}`);
  console.log(`主對話額外：${fmt(u.mainExtra)}`);
  for (const a of u.agents) console.log(`子代理 ${a.description}（${a.models || '?'}，effort ${a.efforts || '?'}）：${fmt(a)}`);
  if (u.toolUses !== u.agents.length) console.log(`注意：transcript 有 ${u.toolUses} 個子代理呼叫，只找到 ${u.agents.length} 個子代理紀錄`);
  console.log(`額外合計 ${u.extra}，約 ${u.ratio ?? '?'}C（API 計價口徑）`);
  return u;
}

function done() {
  const job = need();
  if (job.status !== 'running') return console.log(`job 狀態已經是 ${job.status}`);
  job.doneAt = Date.now();
  L.saveJob(job);
  const u = usage(false);
  const st = L.ledgerStats(job);
  dropCopies(job);
  job.status = 'done';
  job.phase = 'done';
  L.saveJob(job);
  const row = { id: job.id, tier: job.tier, source: job.source, cwd: job.cwd, startedAt: job.startedAt, doneAt: job.doneAt, C: u.C.weighted, extra: u.extra, ratio: u.ratio, agents: u.agents.map((a) => ({ d: a.description, w: a.weighted, model: a.models, effort: a.efforts })), fixRounds: job.fixRounds, ...st };
  fs.appendFileSync(L.HISTORY_FILE, `${JSON.stringify(row)}\n`);
  L.log(`[${job.id}] 完成：發現 ${st.findings}、已修 ${st.fixed}、未解決 ${st.open}、額外 ${u.ratio ?? '?'}C`);
  console.log(`job ${job.id} 完成｜發現 ${st.findings}｜已修 ${st.fixed}｜駁回 ${st.rejected}｜未解決 ${st.open}｜修正 ${job.fixRounds} 輪｜C=${u.C.weighted}｜額外 ${u.extra}（約 ${u.ratio ?? '?'}C）`);
}

function cancel() {
  let n = 0;
  for (const job of L.listJobs()) {
    if (job.status !== 'running' || (arg !== 'all' && job.id !== arg)) continue;
    dropCopies(job);
    job.status = 'cancelled';
    L.saveJob(job);
    L.log(`[${job.id}] 已取消`);
    n++;
  }
  console.log(`已取消 ${n} 個 job`);
}

function clean() {
  const days = Number(arg ?? 7);
  const limit = Date.now() - days * 86400000;
  let n = 0;
  for (const job of L.listJobs()) {
    if (job.status === 'running' || (job.updatedAt || job.startedAt) > limit) continue;
    dropCopies(job);
    fs.rmSync(L.jobDir(job.id), { recursive: true, force: true });
    n++;
  }
  try {
    for (const f of fs.readdirSync(L.DIRS.sessions)) {
      const s = L.readJson(path.join(L.DIRS.sessions, f));
      if (!s || !L.loadJob(s.jobId)) fs.unlinkSync(path.join(L.DIRS.sessions, f));
    }
  } catch {}
  console.log(`已刪除 ${n} 個 ${days} 天前結束的 job（history.jsonl 保留）`);
}

function status() {
  console.log(`啟用：${cfg.enabled ? '是' : '否'}｜觸發字串：${cfg.trigger}1–${cfg.trigger}${L.MAX_TIER}（只打 ${cfg.trigger} 等於檔位 ${cfg.defaultTier}）｜自動掃描：${cfg.autoScan ? '開' : '關'}｜保溫 ${cfg.keepAliveSec} 秒`);
  const jobs = L.listJobs().sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
  if (!jobs.length) return console.log('job：無');
  for (const j of jobs) console.log(`- ${j.id}｜${j.status}/${j.phase}｜檔位 ${j.tier}｜快照 ${j.snapshot?.kind}｜修正 ${j.fixRounds} 輪｜${when(j.startedAt)}｜${j.cwd}`);
}

function log() {
  const n = Number(arg) || 30;
  try {
    console.log(fs.readFileSync(L.LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n'));
  } catch {
    console.log('還沒有紀錄');
  }
}

// 手動掃描指定檔案；沒問題不輸出
function scan() {
  for (const i of S.scanFiles([arg, ...rest].filter(Boolean).map((f) => path.resolve(f)))) console.log(`- ${L.slash(i.file)}｜${i.problem}`);
}

const cmds = { status, log, scan, prep, wait, 'fix-start': fixStart, 'fix-end': fixEnd, usage, done, cancel, clean };
if (cmds[cmd]) Promise.resolve(cmds[cmd]()).catch((e) => console.log(`錯誤：${e.message || e}`));
else console.log('用法：node cli.js [status|log [行數]|scan <檔案…>|prep <job>|wait <job> [檔名…] [--max 秒]|fix-start <job>|fix-end <job>|usage <job>|done <job>|cancel <job|all>|clean [天數]]');
