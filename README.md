# crosscheck

專抓粗心：說了沒做到、串接漏接、跨檔沒同步、寫錯字或條件。常駐的機械掃描不花 token；打觸發字串才叫子代理做盲測與 diff 審查。想周全、需求解讀、替代做法交給姊妹工具 [blindspot](../blindspot)。

## 摘要
- 常駐：Stop hook 掃這回合改過的檔（語法、衝突標記、省略註解、README 漏列設定鍵、沒執行指令卻說已驗證），有問題擋一次請主對話修，沒問題不輸出。
- 觸發：prompt 任意位置打 `%%1`–`%%3`（前後要空白），只打 `%%` 等於 `%%2`；舊的 `%%4`、`%%5` 視同 `%%3`。
- `%%1` 只有機械掃描＋主對話照清單自查，不叫子代理；`%%2` 加盲測與 diff 審查；`%%3` 盲測全覆蓋、diff 審查跑兩輪、推論交 validate、修正後 recheck。
- 核心是盲寫驗收案例：檢查者先只看原始需求與快照寫案例，之後才看主對話的介面說明，轉成測試去跑。
- 子代理用 general-purpose＋`prompts/*.md` 範本，不做 skill、不加 `~/.claude/agents/`，避免描述常駐每個 session。
- token 用量從 transcript 算，寫進 `state/history.jsonl`，累積後拿來校正檔位。

## 為什麼和 blindspot 分開
- 粗心是收斂問題：對照規格逐條核對，同一份清單多掃幾次最有效，判定只有成立／駁回，主對話自己就能修，越便宜越好。
- 思考不完全是發散問題：要在實作前展開解讀、前提、情境、替代做法，多個低相關視角最有效，結果多半要使用者決定。
- 混在一起時兩邊都做不到位：前提質疑排在實作後太晚、帳本塞不下「刻意不做」、也沒辦法只要其中一種。

## 檔位
- `%%1`：機械掃描；主對話照 `prompts/diffcheck.md` 的清單自己過 diff，risks.md 每題寫一個測試；修 1 輪。
- `%%2`：再加 blind（每條關鍵需求至少 1 案例）與 diffcheck 一輪，平行跑；修 1 輪。
- `%%3`：blind 全覆蓋（含邊界、錯誤路徑）；diffcheck 兩輪，第二輪反向閱讀、互不參考；只有推論的發現逐項交 validate；修後叫 recheck；修 2 輪。

## 機械掃描（`scan.js`）
- 語法：`.json`（帶註解的 JSONC 略過）、`.js/.cjs/.mjs` 用 `node --check`（有 JSX 略過）、`.py` 用 `ast.parse`（沒裝 Python 就略過）。
- 殘留：合併衝突標記；程式檔裡的「`// ... existing code`」「`# 其餘不變`」這類省略註解（文件檔不查）。
- 同步：改了 `config.json`，同資料夾 README 有列設定鍵卻漏了某些鍵。
- 說法：這回合改了檔、沒跑過任何 Bash／PowerShell，回覆卻寫「測試通過」「已驗證」。
- 只看最後一則使用者訊息之後用 Edit／Write／MultiEdit／NotebookEdit 改的檔；用 shell 改的檔常駐掃描看不到，觸發 job 時 prep 會從 diff 補掃。
- 擋的是主對話的停止，不是使用者輸入；同一次停止只擋一次，確定是誤報時主對話說明一句就能結束。

## 流程（觸發時）
1. UserPromptSubmit：偵測觸發字串（跟 iter-chain 並用時只看第一段），建立 job：`request.md`（去掉觸發字串與 `stripTokens` 的原文）、`meta.json`、快照。
2. 快照：git repo 用暫時 index 檔把工作目錄（含未追蹤檔）寫成一個不掛分支的 commit，不動你的 index、工作目錄、分支；其他資料夾複製一份（排除 `snapshotExclude`，超過大小或檔數就放棄，改成只依需求盲測）。
3. 主對話完成任務、跑外部驗證，寫 `handoff.md`（改動檔案、介面、驗證結果）與 `risks.md`（中性風險問句）。
4. `cli.js prep`：記下 C 的分界、建立快照 worktree、產生 `diff.patch`、機械掃描寫 `scan.md`、印出要叫的子代理；主對話平行叫出，背景跑 `cli.js wait` 保溫。
5. 主對話整理 `ledger.md`、裁決、修正（`fix-start`／`fix-end` 產生修正 diff 給 recheck）。
6. `cli.js done`：算 token、清 worktree 與快照複本、寫 history；主對話回報發現、修正、未解決與花費。
7. Stop：還沒 prep 就停下，或子代理產出都到了卻沒 done，擋一次；等子代理時、`stop_hook_active` 時、已擋過時都放行。job 進行中不跑常駐掃描。

## 設定（config.json）
- 個人設定寫在同目錄的 `config.local.json`，只寫要改的鍵，會蓋過 `config.json`；更新工具時不會被覆蓋，也不會進 repo。
- `enabled`：總開關。
- `trigger`：觸發前綴（預設 `%%`）；`defaultTier`：只打前綴時的檔位。
- `autoScan`：常駐機械掃描（預設開）。
- `stripTokens`：其他工具的觸發字串，從 `request.md` 去掉（預設 `["^^"]`，blindspot）。
- `keepAliveSec`：`wait` 最長等多久（預設 3000 秒，讓主對話在快取 1 小時有效期內醒一次）；超額使用時快取可能只有 5 分鐘，可改成 240。
- `snapshotMaxMB`、`snapshotMaxFiles`、`snapshotTimeoutSec`、`snapshotExclude`：快照上限與排除。
- `stopBlockMax`：job 未完成時 Stop 最多擋幾次（預設 1）。
- `outputWeight`：加權 token 的輸出倍率（預設 5）。
- `debug`：把 hook 輸入存到 `state/debug/`。

## 指令（`node ~/.claude/crosscheck/cli.js …`）
- `status`、`log [行數]`：最近 10 個 job、事件紀錄。
- `scan <檔案…>`：手動跑機械掃描，沒問題不輸出。
- `prep <job>`、`wait <job> [檔名…] [--max 秒]`、`fix-start <job>`、`fix-end <job>`、`usage <job>`、`done <job>`：主對話照 playbook 用。
- `cancel <job|all>`：停止 job（清 worktree 與快照複本）。
- `clean [天數]`：刪掉 N 天前（預設 7）結束的 job 目錄；history 保留。

## token 計算
- 主對話：觸發那則訊息到 `prep` 之間算 C（含寫 handoff），`prep` 到 `done` 算額外成本；`done` 之後寫回報的那則訊息不計入。
- 小任務的比例會遠超檔位目標：子代理有固定開銷（系統提示、讀檔、跑測試）；檔位目標只在 C 夠大時才接近。
- 子代理：transcript 中 prompt 含 job id 的 Agent 呼叫，對應 `<session>/subagents/*.meta.json` 的 `toolUseId`。
- 加權值是 API 計價口徑（輸入 1、快取讀 0.1、5 分鐘快取寫 1.25、1 小時快取寫 2、輸出 5）；訂閱額度怎麼算未公開。

## 安裝與停用
- toolkeeper：`node ~/.claude/toolkeeper/cli.js deploy crosscheck`，會掛上 UserPromptSubmit 與 Stop 兩個 hook。
- 手動：`~/.claude/settings.json` 的 UserPromptSubmit 與 Stop 各加 `node ~/.claude/crosscheck/hook.js`（Windows 上 `~` 不一定會展開，請換成絕對路徑），timeout 30。
- 暫停：`config.local.json` 寫 `{"enabled": false}`；只關常駐掃描寫 `{"autoScan": false}`。
- iter-chain 整合：`~/.claude/iter-chain` 的 SessionStart 會呼叫 `require('../crosscheck/lib').fromIterChain(input, 本輪指令)`，限額接手時呼叫 `handOver(原 session id, input)`；iter-chain 的完成規則會要求 done 之後才寫輪次檔。

## 測試
- `node test.js`：觸發解析、各項機械掃描、Stop 常駐掃描、prep 的檔位與掃描；狀態寫在系統暫存目錄，不動正式狀態。

## 已知限制
- 子代理 effort 是否真的是 high、model 是否沿用主對話，以 `usage` 印出的 transcript 欄位為準。
- git 快照會在 repo 留下沒有分支指向的 commit 物件，git gc 會自動清。
- 只有在 iter-chain 裡，limit-relay 接手時才會轉交 job；一般 session 撞限額時 job 留在原 session，可用 `cancel` 收掉。
- 同一個 session 裡沒收尾的舊 job，會讓之後沒打觸發字串的訊息在 Stop 時被擋一次；放棄的 job 請用 `cancel`。
- 「說已驗證」的判斷是關鍵字比對，引用前一回合的驗證也可能被當成這回合的說法。
- iter-chain 裡，寫好輪次檔的那次 Stop 若被常駐掃描擋下，下一輪可能已經開始；修正會和下一輪同時進行。
- 端到端只在測試資料夾用 `claude -p` 跑過，互動模式的等待與喚醒以實際使用為準。
