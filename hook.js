// crosscheck 的 hook 入口：UserPromptSubmit、Stop
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const S = require('./scan');

const out = (obj) => process.stdout.write(JSON.stringify(obj));

// 主對話在等背景工作（子代理、指令；例如 blindspot 的視角子代理）時不擋；Claude Code 自己的背景工作不算
const OWN_TASKS = ['dream', 'auto-mode scan', 'memory import'];
const waiting = (input) => (input.background_tasks || []).some((t) => !OWN_TASKS.includes(t.type));

// 沒有觸發字串就什麼都不輸出；有的話建立 job、做快照、注入短指令
function onUserPromptSubmit(input, cfg) {
  const t = L.parseTrigger(L.firstSegment(String(input.prompt || '')), cfg);
  if (!t || !input.cwd) return;
  const job = L.createJob({ tier: t.tier, request: t.request, cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path, source: 'prompt', sibling: t.sibling }, cfg);
  out({
    systemMessage: `crosscheck：檔位 ${job.tier}，job ${job.id}，快照 ${job.snapshot.kind === 'none' ? `失敗（${job.snapshot.reason}）` : job.snapshot.kind}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: L.contextFor(job) },
  });
}

// 流程還沒做完就停下時擋一次；子代理還在跑（等待中）不擋；回傳是否已擋
function jobStop(input, cfg) {
  const job = L.jobOfSession(input.session_id);
  if (!job || job.status !== 'running' || input.stop_hook_active || waiting(input) || job.blocks >= cfg.stopBlockMax) return false;
  if (job.phase === 'review') {
    const dir = L.jobDir(job.id);
    if (!job.expect.length || !job.expect.every((f) => fs.existsSync(path.join(dir, f)))) return false;
  }
  job.blocks++;
  L.saveJob(job);
  L.log(`[${job.id}] Stop 擋下第 ${job.blocks} 次（階段 ${job.phase}）`);
  out({ decision: 'block', reason: `crosscheck job ${job.id} 還沒跑完：讀 ${L.slash(path.join(L.ROOT, 'playbook.md'))} 繼續；如果你停下是在等使用者回答，再停一次即可。` });
  return true;
}

// 常駐掃描：這回合改過的檔有機械可查的粗心，就擋一次請主對話修；沒問題不輸出
// job 進行中不掃：prep 已經掃過，等子代理時改檔會讓盲測對不上
function scanStop(input, cfg) {
  if (!cfg.autoScan || input.stop_hook_active || !input.transcript_path) return;
  if (L.jobOfSession(input.session_id)?.status === 'running') return;
  const issues = S.scanTurn(input);
  if (!issues.length) return;
  L.log(`自動掃描 ${issues.length} 項：${issues.map((i) => i.problem).join('；').slice(0, 300)}`);
  const list = issues.map((i) => `- ${i.file ? `${L.slash(i.file)}：` : ''}${i.problem}`).join('\n');
  out({ decision: 'block', reason: `crosscheck 掃描到可能的粗心：\n${list}\n確認後修正；確定不是問題就在回覆說明一句後結束（不會再擋）。` });
}

function main() {
  const cfg = L.loadConfig();
  const input = L.readStdin();
  if (!cfg.enabled || !input.session_id) return;
  if (cfg.debug) L.writeJson(path.join(L.DIRS.debug, `${input.hook_event_name}.json`), input);
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return onUserPromptSubmit(input, cfg);
    case 'Stop':
      return jobStop(input, cfg) || scanStop(input, cfg);
  }
}

try {
  main();
} catch (e) {
  L.log(`hook 錯誤：${e.stack || e}`);
}
