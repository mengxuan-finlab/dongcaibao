# 訪客財報試用設定

## 啟用順序

1. 在 Supabase SQL Editor 執行 `sql/guest-financial-trial.sql` 全文。
2. 在 Supabase Authentication 的登入提供者設定啟用 Anonymous Sign-Ins。
3. 發布 `dongcaibao` 的前端與後端更新。
4. 美股一鍵生成改由 Node 後端處理：依 `FINANCIAL_BACKEND_SETUP.md` 執行 `sql/financial-report-jobs.sql` 並發布後端。台股既有排程仍需 service_role key；不要將台股排程一併停掉。

官方設定文件：https://supabase.com/docs/guides/auth/auth-anonymous

匿名登入屬於 Supabase 的 authenticated role，帶有 `is_anonymous` 標記。
SQL 限制每個匿名使用者終身新增一次財報試用，並阻止匿名使用者修改、刪除或重建報告。
既有會員仍可管理自己的追蹤清單，排程的 service_role 不受此限制。

SQL 不修改或刪除既有報告。它增加所有 authenticated 使用者的強制擁有者隔離，並撤銷未登入的 anon role 直接讀取 tracked_stocks 的權限。
如果已有其他系統刻意公開讀取此表，需先確認其需求；公開範例應另存，不能用私人報告表直接公開。

## 驗證

- 無痕視窗新增一檔：免註冊，顯示待處理狀態；重新整理仍顯示同一檔。
- 點第二檔入口：應引導登入。
- 同一匿名 session 直接呼叫資料庫新增第二檔、刪除或更新：應拒絕。
- 使用另一個匿名 session：不能讀到第一位訪客的報告。
- 後端任務完成（台股仍依既有排程）：訪客可讀取自己的 report_json、圖表與 AI 分析。
- 登入既有會員：顯示其原本追蹤清單及 5 檔上限。
- 若匿名登入失敗，檢查是否啟用 Anonymous Sign-Ins，以及原有 auth.users 建立 profile 的 trigger 是否允許 email 為空。

## 限制

訪客 session 存在瀏覽器儲存空間；清除資料、登出或更換瀏覽器後無法找回相同匿名身分。
登入另一個帳號不會自動搬移訪客報告。此版本不批次重生舊報告。
啟用匿名登入後，其他資料表既有的 authenticated RLS 規則也需確認是否應排除 is_anonymous。
此限制是每個匿名身分一次，不能辨識同一個人在清除瀏覽器資料後再次建立的新身分。
對外大量開放時，請依官方文件設定 CAPTCHA／匿名登入速率限制。
