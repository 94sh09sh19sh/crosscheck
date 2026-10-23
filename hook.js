// crosscheck 的 hook 入口：UserPromptSubmit、Stop
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const out = (obj) => process.stdout.write(JSON.stringify(obj));

// 沒有觸發字串就什麼都不輸出；有的話建立 job、做快照、注入短指令
function onUserPromptSubmit(input, cfg) {
  const t = L.parseTrigger(L.firstSegment(String(input.prompt || '')), cfg);
  if (!t || !input.cwd) return;
  const job = L.createJob({ tier: t.tier, request: t.request, cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path, source: 'prompt' }, cfg);
  out({
    systemMessage: `crosscheck：檔位 ${job.tier}，job ${job.id}，快照 ${job.snapshot.kind === 'none' ? `失敗（${job.snapshot.reason}）` : job.snapshot.kind}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: L.contextFor(job) },
  });
}

// 流程還沒做完就停下時擋一次；子代理還在跑（等待中）不擋
function onStop(input, cfg) {
  const job = L.jobOfSession(input.session_id);
  if (!job || job.status !== 'running' || input.stop_hook_active || job.blocks >= cfg.stopBlockMax) return;
  if (job.phase === 'review') {
    const dir = L.jobDir(job.id);
    if (!job.expect.length || !job.expect.every((f) => fs.existsSync(path.join(dir, f)))) return;
  }
  job.blocks++;
  L.saveJob(job);
  L.log(`[${job.id}] Stop 擋下第 ${job.blocks} 次（階段 ${job.phase}）`);
  out({ decision: 'block', reason: `crosscheck job ${job.id} 還沒跑完：讀 ${L.slash(path.join(L.ROOT, 'playbook.md'))} 繼續；如果你停下是在等使用者回答，再停一次即可。` });
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
      return onStop(input, cfg);
  }
}

try {
  main();
} catch (e) {
  L.log(`hook 錯誤：${e.stack || e}`);
}
