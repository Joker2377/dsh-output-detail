# 安裝驗證 · dsh-output-detail 0.1.2

2026-11-04，使用者已授權安裝與試用。**0.3.0** 已透過 plugin_manager 從 tgz 重新安裝至 desktop profile（先移除 0.2.0），回覆 application=applied、warnings=[]。這證明外掛已套用，不代表畫面、設定重開與模型效果全部驗收完成。

## 本輪修正

- 0.1.0 首次安裝在啟用階段失敗：工具 output JSON Schema 的 minimum／maximum 不屬於 rc.5 支援子集；改為 enum [1,2,3,4,5]，參數也對齊相同子集。
- 新增以實際 @deepseek-ai/dsh-tools assertSupportedJsonSchema 檢查 input／output 的回歸；先重現 UNSUPPORTED_SCHEMA，再修至通過。
- Client 的原生 useInput snapshot hook 明確傳入 selector；測試 adapter 同樣要求 selector，不再用接受零參數的寬鬆 fake 掩蓋契約差異。
- 98/98 自動化測試（0 skip）、12檔語法／manifest、13檔 tarball 與隔離入口／exports 載入通過。

## 實際宿主證據

- 0.1.1 及最後 0.1.2 的 plugin_manager 均回 application=applied、warnings=[]。
- Host Config 有 include:output-detail；status=absent 表示未提供 Config schema，不是未載入。packageDir 是 profile/node_modules/dsh-output-detail 的安裝副本，不是源目錄 link。
- 實際 output_detail(action=get) 回成功、level=3、changed=false；未改動目前對話的檔位。
- 0.3.0 的 Client Inspect 顯示 conversation.input.left 內 id=output-detail，active=true。這證明已註冊並啟用，但不單獨證明畫面可讀或模型效果；Client 半邊仍須重載 App 視窗才會換版。
- 原有 cpu-features 0.0.10 可選原生編譯有 enable_thin_lto 錯誤，pnpm 仍 exit 0，外掛最後 application=applied。另有既有 peer／deprecated 警告；未修改其他套件修補它們。

## 試用（請用新測試會話）

1. 重新整理目前 App。輸入框左側應出現「回答詳略」五格計量，初始標準 3。
2. 調到5，確認「主機目前選取」為5；重新整理／重開該會話，檢查仍是5。另開新會話應回3。也可用 /output-detail 讀取實際值。
3. 一般草稿中按「固定到本則」，檢查獨立行 [[dsh-detail:v1:5]]；原生送出後 human 文字應原樣，另有 context 指引摘要。
4. 同一簡單問題分別在1及5試答，觀察篇幅與解釋深度；這是提示偏好，沒有嚴格字數保證。不要用具有明確「只回一行」要求的問題比較，因為正文要求優先。

未在現有對話送測試訊息，未 commit／push／發布。原 VERIFICATION.md 是0.1.0本地交付快照；目前安裝狀態以本檔為準。
