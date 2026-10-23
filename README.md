# crosscheck

主對話完成任務後，用同模型、high effort 的子代理做盲測、審查、修正、複查。只在 prompt 打觸發字串時啟用，沒打就零成本。

## 摘要
- 語法：prompt 任意位置打 `%%1`–`%%5`（前後要空白），只打 `%%` 等於 `%%2`；額外預算約 +0.2C 到 +1.0C（C＝主對話完成任務本身的用量）。
- 啟用方式：UserPromptSubmit hook 存原始需求、做改動前快照、注入約 120 token 的短指令；主對話做完任務後讀 `playbook.md` 照做。
- 核心是盲寫驗收案例：檢查者先只看原始需求與快照寫案例，之後才看主對話的介面說明，轉成測試去跑。
- 子代理用 general-purpose＋`prompts/*.md` 範本，不做 skill、不加 `~/.claude/agents/`，避免描述常駐每個 session。
- 子代理產出都寫在 job 目錄，回傳只有一行，主對話需要時才讀。
- token 用量從 transcript 算，寫進 `state/history.jsonl`，累積後拿來校正檔位。

## 檔位
- `%%1`：1 個 blind（只針對主對話列的風險問題，最多 3 案例）；修 1 輪。
- `%%2`：blind 涵蓋所有關鍵需求＋review（目標倒推四層、找缺漏、資安／維運／新手三角度），平行跑；修 1 輪。
- `%%3`：blind 全覆蓋（含邊界、錯誤路徑）；只有推論的發現逐項交 validate；修後叫 recheck；修 2 輪。
- `%%4`：再加 premise（反方，盲列需求的各種解讀與可能錯的前提）；修 2 輪。
- `%%5`：blind 另外盲寫設計判斷再比對；修 3 輪。

## 流程
1. UserPromptSubmit：偵測觸發字串（跟 iter-chain 並用時只看第一段），建立 job：`request.md`（去掉觸發字串的原文）、`meta.json`、快照。
2. 快照：git repo 用暫時 index 檔把工作目錄（含未追蹤檔）寫成一個不掛分支的 commit，不動你的 index、工作目錄、分支；其他資料夾複製一份（排除 `snapshotExclude`，超過大小或檔數就放棄，改成只依需求盲測）。
3. 主對話完成任務、跑外部驗證，寫 `handoff.md`（改動檔案、介面、驗證結果）與 `risks.md`（中性風險問句）。
4. `cli.js prep`：記下 C 的分界、建立快照 worktree、產生 `diff.patch`、印出要叫的子代理；主對話平行叫出，背景跑 `cli.js wait` 保溫。
5. 主對話整理 `ledger.md`、裁決、修正（`fix-start`／`fix-end` 產生修正 diff 給 recheck）。
6. `cli.js done`：算 token、清 worktree 與快照複本、寫 history；主對話回報發現、修正、未解決與花費。
7. Stop：還沒 prep 就停下，或子代理產出都到了卻沒 done，擋一次；等子代理時、`stop_hook_active` 時、已擋過時都放行。

## 設定（config.json）
- 個人設定寫在同目錄的 `config.local.json`，只寫要改的鍵，會蓋過 `config.json`；更新工具時不會被覆蓋，也不會進 repo。
- `enabled`：總開關。
- `trigger`：觸發前綴（預設 `%%`）；`defaultTier`：只打前綴時的檔位。
- `keepAliveSec`：`wait` 最長等多久（預設 3000 秒，讓主對話在快取 1 小時有效期內醒一次）；超額使用時快取可能只有 5 分鐘，可改成 240。
- `snapshotMaxMB`、`snapshotMaxFiles`、`snapshotTimeoutSec`、`snapshotExclude`：快照上限與排除。
- `stopBlockMax`：Stop 最多擋幾次（預設 1）。
- `outputWeight`：加權 token 的輸出倍率（預設 5）。
- `debug`：把 hook 輸入存到 `state/debug/`。

## 指令（`node ~/.claude/crosscheck/cli.js …`）
- `status`、`log [行數]`：最近 10 個 job、事件紀錄。
- `prep <job>`、`wait <job> [檔名…] [--max 秒]`、`fix-start <job>`、`fix-end <job>`、`usage <job>`、`done <job>`：主對話照 playbook 用。
- `cancel <job|all>`：停止 job（清 worktree 與快照複本）。
- `clean [天數]`：刪掉 N 天前（預設 7）結束的 job 目錄；history 保留。

## token 計算
- 主對話：觸發那則訊息到 `prep` 之間算 C（含寫 handoff），`prep` 到 `done` 算額外成本；`done` 之後寫回報的那則訊息不計入。
- 小任務的比例會遠超檔位目標：子代理有固定開銷（系統提示、讀檔、跑測試），實測 `%%1` 在 C≈5 萬的小任務上約 2.7C；檔位目標只在 C 夠大時才接近。
- 子代理：transcript 中 prompt 含 job id 的 Agent 呼叫，對應 `<session>/subagents/*.meta.json` 的 `toolUseId`。
- 加權值是 API 計價口徑（輸入 1、快取讀 0.1、5 分鐘快取寫 1.25、1 小時快取寫 2、輸出 5）；訂閱額度怎麼算未公開。

## 安裝與停用
- `~/.claude/settings.json` 的 UserPromptSubmit 與 Stop 各加一個 hook：`node ~/.claude/crosscheck/hook.js`（Windows 上 `~` 不一定會展開，請換成實際的絕對路徑），timeout 30。
- 暫停：`config.local.json` 寫 `{"enabled": false}`；移除：刪掉上述兩個 hook。
- iter-chain 整合：在 `~/.claude/iter-chain/hook.js` 的 `onSessionStart` 結尾，把本輪指令交給 `require('../crosscheck/lib').fromIterChain(input, r.instruction)`，回傳的文字附在注入內容後面；限額接手那條路改呼叫 `handOver(原 session id, input)`，把還在跑的 job 轉給新 session。已接上；iter-chain 的完成規則會要求 done 之後才寫輪次檔，Stop 時 job 還在 running 也不會接續下一輪。iter-chain 的 SessionStart hook 逾時要 30 秒（快照最多 15 秒），太短會連本輪指令一起遺失。

## 已知限制
- 子代理 effort 是否真的是 high、model 是否沿用主對話，以 `usage` 印出的 transcript 欄位為準。
- git 快照會在 repo 留下沒有分支指向的 commit 物件，git gc 會自動清。
- 只有在 iter-chain 裡，limit-relay 接手時才會轉交 job（記在 meta.json 的 `handovers`，token 統計會合併各 session）；一般 session 撞限額時 job 留在原 session，可用 `cancel` 收掉。
- 同一個 session 裡沒收尾的舊 job，會讓之後沒打觸發字串的訊息在 Stop 時被擋一次；放棄的 job 請用 `cancel`。
- 端到端只在測試資料夾用 `claude -p` 跑過，互動模式的等待與喚醒以實際使用為準。
