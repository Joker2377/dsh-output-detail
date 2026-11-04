# dsh-output-detail

[![test](https://github.com/Joker2377/dsh-output-detail/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-output-detail/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Five levels of reply detail in the composer — the selection lives in the Session log, and the control shows what the Host actually folded.*

Composer 左側一格五段計量，決定 agent 下一輪回覆要多詳細：極簡、精簡、標準、深入、完整剖析。**只加回答指引**，不改模型、不改推理強度、不改 temperature。

畫面沒有自己的狀態。點一格就是一次 `/output-detail N` 命令，選取由 Session log 的 `command/run`＋`command/done` 摺疊出來，控制項永遠顯示主機投影。純 host＋client 外掛，沒有常駐服務、沒有網路請求、不改 profile。

> [!NOTE]
> 需要 DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`、Node.js `>=22.19`。外掛把 `zod` 宣告成 peer，由 host profile 提供。

## 功能

- **五個檔位，一眼看出現在是哪一級。** 五段計量＋檔位名稱，點一格或按方向鍵／Home／End 切換；一次操作一次命令。
- **選取只存在 Session log。** 投影從既有的 command 生命週期摺疊，重開、restore、fork 都由日誌重建；新會話從「標準」開始。
- **前端不保存檔位。** 點下去直接送命令，主機回覆前只顯示「儲存中…」，不會先跳一個本地預覽值再被主機打回來。
- **只加指引，不動模型。** 每則受影響的訊息另附一則 scoped context；模型參數、system prompt、temperature 都不變。
- **看得見，不是隱藏設定。** 每次改檔位在會話留下一行命令紀錄，context 注入列也看得見；人類訊息與附件原樣保留。
- **子代理不套用。** `origin=subagent` 的 session 直接通過，不會把使用者的偏好套到 agent 的內部 task 上。

## 安裝

就一個連結。

1. 複製倉庫網址：

   ```text
   https://github.com/Joker2377/dsh-output-detail
   ```

2. 在 DSH 側邊欄打開 **Plugins**，把網址貼進安裝欄位，按 **Install**。
3. 重新載入 App（重開視窗，或 `Ctrl+R`）。輸入框左側就會出現「回答詳略」五格計量。

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/.../tree/main` 這類頁面網址會被拒絕（`a URL must point at a git repository or a tarball`）。
>
> 要鎖定某一版，把 commit 接在後面：`https://github.com/Joker2377/dsh-output-detail#<commit>`。

> [!WARNING]
> 不要用 `link:` 安裝這份沒有 `node_modules` 的源目錄。Node 會從源目錄解析入口，而 `zod` 是 profile 提供的 peer，接著可能找不到。要從本機安裝就先用 `npm pack --ignore-scripts` 打包，再用產生的 `.tgz` 實體路徑安裝。

解除安裝：在 **Plugins** 頁移除這個 bundle 後重新載入。已記錄的檔位不會被刪除，它只是 Session log 裡的一般命令事件。

## 使用

### 選檔位

| 檔位 | 什麼時候用 |
| --- | --- |
| 極簡 | 只要結論與必要的警告 |
| 精簡 | 結論＋關鍵理由或步驟 |
| 標準 | 預設。講到能照著做為止 |
| 深入 | 需要機制、假設、例子、取捨 |
| 完整剖析 | 系統性涵蓋替代方案、邊界情況、失敗模式 |

控制項是一列 26px 高的元件：標籤、五格計量、目前檔位名稱、必要時的短狀態。沒有主機投影時不會假裝停在 3 級，檔位顯示「—」、五格全灰。

### 命令與工具

```text
/output-detail       # 讀取目前檔位
/output-detail 2     # 設為精簡
```

agent 端對應的延遲載入工具是 `output_detail`：`action: "get"` 只讀，`action: "set"` 要你明確要求改檔位才會用。它與命令走同一條路徑。

### 取值時點

**檔位取的是 agent 處理那則訊息時的選取，不是按 Send 時的。** 一次送多則、或在 agent 忙著時改檔位，後面的訊息會用新的檔位；目前沒有固定單則的機制，見「已知限制」。

### 失敗時

- 標籤變「同步失敗」，滑過去或讀螢幕閱讀器可以拿到完整的主機訊息；工具列不會被撐開。
- 畫面保持主機投影的檔位，不會因為請求失敗而跳值。
- 舊請求的失敗不會蓋過較新的請求。

## 疑難排解

| 症狀 | 可能原因 | 處理 |
| --- | --- | --- |
| 輸入框左側沒有控制項 | 外掛沒載入、或視窗還沒重載 | 看 Plugins 頁的狀態；重新載入 App |
| 還是上一個版本的介面 | client bundle 在重載前不會換版 | `Ctrl+R`，或關掉視窗重開 |
| 檔位顯示「—」、五格全灰 | 這個 session 還沒有投影（剛建立、或外掛剛載入） | 送一則訊息，或重載 App |
| 一直停在「儲存中…」 | 命令沒有回來（host 忙碌或 session 已換） | 換到下一個檔位再改回來；持續發生就看 App 日誌 |
| 每次改檔位都多一行紀錄 | 這是設計：選取要靠 Session log 才能重開後重建 | 沒有開關 |

## 運作原理

- **投影（唯一真相）**：`lib/projection.js` 摺疊 `command/run` 與 `command/done`。較舊的命令完成事件會被忽略，所以連點時最後一次命令勝出。state 只有 `level`、pending 與 `inheritedEventCount`，`stateVersion` 變更即完整重折。
- **注入**：`lib/host.js` 在每個 live agent 的 scope 掛 `agent/pre-step`，讀一次投影、等下游決策成立，再把一則非人類的 context 訊息插在每則人類訊息後面。同一個 batch 重試不會重複插。
- **context 訊息**：`source.kind = "output-detail"`、`form: "notice"`，附可讀 summary 與 `targetId`。Chat 會把它收成 context 列，不會混進人類氣泡。
- **Client**：只註冊 `conversation.input.left` 一格。點擊呼叫 `ctx.remote.commands.execute(sessionId, '/output-detail N', [])`，畫面只讀 `useProjection`。

## 開發

```bash
npm test                                            # 76 個測試，不需要安裝依賴
DSH_RUNTIME_ROOT=<dsh root> npm test                # 加上真實宿主 Zod，76/76 全跑
node scripts/check.mjs                              # manifest、locale、icon、語法
node scripts/runtime-check.mjs <dsh root>           # 真實 Cordis／Session／Projection／Zod
node scripts/package-check.mjs ./dsh-output-detail-<version>.tgz <dsh root>
node scripts/preview.mjs                            # 產生 demo/preview.html（真實 bundle 渲染）
```

Client 測試以 VM／fake React 驅動真正的元件回呼，不冒充瀏覽器驗證；`scripts/preview.mjs` 只產出設計審閱用的靜態頁。[VERIFICATION.md](VERIFICATION.md) 記錄每一版拿到什麼證據、還有什麼沒驗。

CI 在 `ubuntu-latest` 與 `windows-latest` 上跑 Node 22 與 24：先 `node scripts/check.mjs`，再 `npm test`。CI 不安裝任何依賴，所以需要宿主 Zod 的那一項會明確 skip，不會假裝跑過。

## 已知限制

- **沒有單則固定。** 檔位是會話級；一次送多則、或在排隊時改檔位，後面的訊息會用新檔位。
- **每次改檔位留下一行命令紀錄。** 選取必須寫進 Session log 才能重建，目前只有這個機制。
- **連點會各送一次命令。** 沒有前端佇列，靠投影「最新 run 勝出」收斂。
- **取值不是 Send 時的快照。** 實際時點是 `agent/pre-step`。
- **注入會進入模型歷史。** 它不是隱藏設定，只是非人類氣泡的一則 context；成本上等於每則訊息多一段短指示。
- **提示是偏好，不是保證。** 沒有付費模型品質、token 或快取實測；明確的篇幅／格式／語言要求優先於檔位。
