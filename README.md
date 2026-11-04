# DSH 回答詳略 · Response Detail

> 2026-11-04 精簡版：**0.3.0** 移除單則標記（pin）與前端選取狀態。控制項只顯示主機投影，點檔位直接送命令，不再有本地預覽值、佇列或同步狀態機。0.3.0 由 tgz 安裝到 desktop；改版後 76/76 測試通過（含真實宿主 Zod），並以 `demo/preview.html` 實渲染截圖檢查淺色／深色。

給 DeepSeek Harness 的五檔回答詳略控制：Composer 左側一格遞增計量，點檔位或按方向鍵即可切換。新會話預設「標準」，送出後保留選取；只加回答指引，不改模型、推理強度或 temperature。

**這是 best-effort 外掛，不是原生 Send 快照。** 自動模式取 Agent 進入 pre-step 時的檔位，排隊及附件處理期間調整檔位，仍可能影響未處理的訊息；沒有單則覆寫機制。

**選取只存在於 Session log。** 每一次改檔位都是一次 `/output-detail N` 命令，投影從 `command/run`＋`command/done` 摺疊出目前檔位；前端不另外保存檔位，畫面永遠顯示主機投影（回覆未到前顯示「儲存中…」）。

同步會留下正常命令紀錄（目前回覆為 JSON）；每則受影響的訊息另有簡短 context 注入列。**人類訊息與附件原樣保留**，英文 policy 不會塞進人類氣泡；它在獨立 context 訊息內，仍會進入模型歷史。不是隱藏或無痕設定。

## 功能

- 五檔：極簡、精簡、標準、深入、完整剖析；標準也是明確的本則指引。
- 選取由既有 command/run、command/done 事件與 session projection 重建，不寫全域 system prompt、模型參數或私用 metadata。
- 原生 conversation.input.left slot；原生送出、附件、引用與草稿仍由 DSH 管理。
- 前端不保存檔位：點擊直接送命令，顯示值一律來自 Host 投影。
- 命令與工具共用設定操作；子代理 task 不自動加提示。

## 安裝邊界與方式

需求：DSH 0.2.1-rc.5 或更新的 0.2.x、Host 的 agents／commands／tools／sessionProjections，以及目前的 Composer slot、locale、remote commands；Node.js 22+。版本下限以實際核對的 rc.5 為準，不代表已逐版本實測。Zod 4 為 peer，由消費端安裝環境提供。

**使用 tarball 的實體副本安裝，不要直接安裝這份無 node_modules 的絕對源目錄。** DSH 本地目錄通常成為 link，Node 會從源目錄解析入口的 Zod，不能假設一定找得到 profile 的 peer。

```sh
npm pack --ignore-scripts
```

另行授權安裝時，在 DSH bundle 安裝介面指定產生的 .tgz 絕對路徑，或請 Agent 使用 plugin_manager 安裝該檔。**不要手改 profile 的套件／patch，也不要在 profile 目錄執行 npm install。** 本次只建立本地封裝，不會自動安裝、commit、push、發布 npm 或 GitHub release。

封裝測試會把 tarball 解到獨立暫存 node_modules，複製既有可信宿主的無相依 Zod peer，驗證 ESM 入口與 exports 可以解析；不下載依賴、不執行 npm 安裝、不修改 profile。這不是 App 內實際安裝驗收。

## 使用

### 自動模式

控制項是一列 26px 高的元件：標籤「回答詳略」、五格遞增計量、目前檔位名稱、必要時的短狀態。點某一格或聚焦後按方向鍵／Home／End 切換；**一次點擊就是一次 `/output-detail N` 命令，沒有本地預覽值**——畫面在主機投影更新前保持原檔位，並在等待期間顯示「儲存中…」。連點會各自送出命令，最後完成的那次命令決定選取（舊命令的完成事件會被投影忽略）。

選取留在該會話；重新開啟可由日誌重建。新建與 fork 會話從標準開始。沒有主機投影時不會假裝停在 3 級：檔位顯示「—」、五格全灰。

失敗時顯示「同步失敗」短標籤，完整主機訊息在同一個狀態格的 tooltip 與 aria-label，不會撐開工具列。

### 命令與工具

```text
/output-detail       # 讀取目前檔位
/output-detail 2     # 設為精簡
```

output_detail 工具接受 `action: "get"` 或 `action: "set", level: 1..5`。set 透過相同命令，因此也會留下命令紀錄；「只在使用者明確要求時 set」是模型使用政策，不是程式判讀自然語言授權。get 不寫入設定。

## 行為與限制

- 明確篇幅、格式、語言要求優先；必要程式碼、文件、警告與工作完整性不能因極簡檔省略。
- 同步處理多則人類訊息時，各自附一則 scoped context；不保證模型為每則各回一段，也不保證精確字數。
- 附件-only 也只加獨立 context，不改附件區塊。
- 已帶本外掛 context 的同一 batch 重試不重複加；resume 沿用已記錄歷史，不在每個工具步驟重複追加。
- origin=subagent 的 Agent 原樣通過（即使 task 的 source.kind 是 user）；普通 fork 不因此排除。工具結果、其他 context 不加提示。
- 原生 slot 沒有已核實的 readOnly prop；主要依 capability 與宿主授權 gate。程式保留 optional readOnly 防護，但不宣稱已驗證唯讀／archive 全部路徑。
- Remote commands 只有三個參數，不支援 transport abort；切換 session／卸載時靠 epoch／sequence 丟棄過期回覆，不宣稱已取消 Host 命令。
- 停用不改歷史；已排隊的訊息仍照當時的檔位處理。
- 日誌 checkpoint／crash 耐久性沿用宿主，不宣稱額外 fsync。

提示是偏好，不是品質或 token 節省保證；沒有付費模型品質、快取或成本實測。完整 policy 可能隨後續歷史重送。v1 格式固定；未來版本需同步更新 Host／Client parser、formatter 與遷移測試。

## 開發與驗證

```sh
node --run test
node --run check
# 明確使用既有可信 DSH 安裝的依賴，不會安裝或建立 symlink
node scripts/runtime-check.mjs /absolute/path/to/dsh
DSH_RUNTIME_ROOT=/absolute/path/to/dsh node --run test
# 自己建立的 tarball + 可信宿主依賴之隔離載入檢查
node scripts/package-check.mjs ./dsh-output-detail-0.3.0.tgz /absolute/path/to/dsh
```

Node 內建 runner；Client 以 VM／fake React 驅動實際元件回呼，不冒充瀏覽器驗證。裸源目錄沒有 Zod 且未設 DSH_RUNTIME_ROOT 時，real-Zod 一項會明確 skip；指定可信宿主後可全跑。runtime-check 用真實 Cordis、Session、SessionProjectionRegistry、Zod、YAML；宿主根目錄沒有供 Node 直接載入的 React，未另裝套件補跑。

分層：style 負責提示與 human/context 分離；projection 只摺疊 command 生命週期；host 註冊命令、延遲工具、scoped pre-step；client 是原生 slot 控制，且不保存檔位。無獨立 HTTP 端點、DOM 攔截、inbox 改寫或隱藏碼。

本次證據與審查處置見 [VERIFICATION](./VERIFICATION.md)。遇到不同版本無法顯示，先查公開 slot／projection／command capability，不以 monkeypatch 修補原生 Send。

## 參考與授權

提示策略參考 [caveman](https://github.com/JuliusBrussee/caveman)、[i-have-adhd](https://github.com/ayghri/i-have-adhd) 的去贅詞／資訊分組，以及 [Explanatory output style](https://code.claude.com/docs/en/output-styles)；指引為自行撰寫，未搬入角色口吻、診斷假設或 session persistence。亦參考 [dsh-prompt-injector](https://github.com/yukk4159-bit/dsh-prompt-injector) 與官方 lifecycle，但未複製 session-only 綁定。

MIT。私有 repo 建立不表示程式已 push、CI 已通過或已發布；以驗證紀錄為準。
