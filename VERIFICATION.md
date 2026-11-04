# 本地驗證 · dsh-output-detail 0.3.0（移除單則標記與前端狀態）

## 這是什麼

0.3.0 把上一個版本留下的兩個機制拿掉：**單則標記（pin / `[[dsh-detail:v1:N]]`）** 與**前端的選取狀態**。理由是同一個：檔位只是一個很短的會話偏好，主機投影本來就是唯一權威，前端再存一份只會製造分叉與同步狀態機。

- 選取仍然「存」在 Session log 裡（`command/run`＋`command/done` 摺疊），這一點沒變；變的是**前端不再有第二份狀態**：點一格就送一次 `/output-detail N`，畫面永遠顯示 Host 投影，等待期間只顯示「儲存中…」。
- 沒有 marker、沒有 `appliedLevel` 之外的字串解析、沒有草稿插入、沒有 `inputActions`／`useInput`、沒有 optimistic 值、沒有佇列、沒有把 binding 折進投影。
- 投影 state 因此簡化：`level`、`pendingCommandId`、`pendingLevel`、`inheritedEventCount`；`stateVersion` 從 1 升到 2（形狀變了，需要完整重折）。

## 已取得證據（2026-11-04）

- 完整回歸：**76 tests／76 pass／0 fail／0 skip**（指定 `DSH_RUNTIME_ROOT` 用真實宿主 Zod 跑滿；裸源目錄時 real-Zod 一項 skip 為 74/76）。
  - 刪掉的是只為舊功能存在的測試（marker 解析、binding 摺疊、chip 游標換算、圍籬／行內程式碼判斷、pin 停用狀態），不是把斷言放寬。
  - 新增／改寫：點擊直接送命令且畫面不領先投影、無投影不假裝 3 級、連點各自送出且舊回覆不能蓋新錯誤、換會話丟棄過期回覆、bundle 不得再引用 `insertText`／`inputActions`／`useInput`／`marker`／`optimistic`。
- `node scripts/check.mjs`：manifest、locale、icon 與全部 JS／MJS 語法檢查。
- `scripts/runtime-check.mjs`（真實 Cordis／Session／SessionProjectionRegistry／Zod／YAML）：投影註冊、初始讀取、command 生命週期摺疊、wire snapshot、disposal。
- `scripts/package-check.mjs`：0.3.0 tarball 解到獨立暫存 node_modules，以宿主 Zod 載入入口與全部 exports。
- 渲染：`scripts/preview.mjs` 用**真實 bundle** 產生 `demo/preview.html`（6 個狀態），headless Chrome 3x 截圖檢查淺色／深色（`demo/simplified.png`、`demo/final2-dark.png` 為對照）。

## 與 0.2.0 的差異

| 項目 | 0.2.0 | 0.3.0 |
| --- | --- | --- |
| 單則固定 | pin 按鈕插入可見 marker，投影依 marker 建 binding | 移除；檔位一律是會話級 |
| 投影 state | `level`＋`bindings`＋pending＋inherited | `level`＋pending＋inherited（`stateVersion` 2） |
| 前端檔位 | `held` 本地覆寫值，成功後保留到投影移動 | 無：畫面＝投影，`pending` 只控制「儲存中…」 |
| 送出節奏 | 單一 in-flight＋最新意圖佇列 | 每次點擊直接送；投影以 commandId 忽略較舊的完成事件 |
| 元件 | 標籤＋計量＋名稱＋狀態＋pin 圖示 | 標籤＋計量＋名稱＋狀態（少了 22px 與一段互動） |
| Client 依賴 | `useProjection`＋`useInput`＋`inputActions` | 只有 `useProjection` |

## 尚未驗證／已知限制

- **未在 App 內目視**：仍只驗到程式層級與渲染層級。重裝後需重載 App 視窗（Ctrl+R）才會載入新的 client bundle。
- **每次改檔位仍會留下 `command/run` 紀錄**：這是目前唯一能把選取寫進 Session log 的既有機制；0.3.0 只保證「一次點擊一次命令」。
- **連點會各送一次命令**：不再有前端佇列合併，靠投影的「最新 run 勝出」規則收斂。若之後要省命令，那是刻意的產品取捨，不是這次的 bug。
- 自動化測試用 VM／fake React，不是真實 React 或瀏覽器；CSS 只在預覽頁被瀏覽器解析過。
- `stateVersion` 升版代表舊投影快取會完整重折一次；沒有資料遷移（Session log 是唯一真相，重折即可）。

## 重現

```sh
node --run test                                   # 76 tests
DSH_RUNTIME_ROOT=<dsh root> node --run test       # 含真實宿主 Zod，76/76
node scripts/check.mjs
node scripts/runtime-check.mjs <dsh root>
node scripts/package-check.mjs ./dsh-output-detail-0.3.0.tgz <dsh root>
node scripts/preview.mjs                          # demo/preview.html
```

## 版本沿革

- 0.1.x：五檔滑桿、投影摺疊、pre-step 注入、單則 marker。
- 0.2.0：滑桿改五格計量、狀態短標籤、修正回跳與不可用狀態、pin 改用 aria-disabled。
- 0.3.0：移除 marker 與前端狀態，選取只剩 Session log。
