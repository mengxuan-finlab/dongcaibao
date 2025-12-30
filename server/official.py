import os
import requests
import re
from datetime import datetime, timedelta
import google.generativeai as genai
from supabase import create_client
from dotenv import load_dotenv

# 1. 基礎設定與環境變數載入
load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
# 這裡建議使用 service_role key 以確保有權限更新資料
supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

def process_stock(stock_row):
    symbol = stock_row['symbol']
    row_id = stock_row['id']
    print(f"🚀 開始處理：{symbol} (ID: {row_id})")

    try:
        # Step 1: 從 FMP 尋找最近四個月的 10-Q 或 10-K
        url = "https://financialmodelingprep.com/stable/sec-filings-search/symbol"
        params = {
            "symbol": symbol,
            "apikey": os.getenv("FMP_API_KEY"),
            "limit": 50,
            "from": (datetime.now() - timedelta(days=120)).strftime('%Y-%m-%d'),
            "to": datetime.now().strftime('%Y-%m-%d')
        }
        res = requests.get(url, params=params).json()
        
        report = next((item for item in res if item.get('formType') in ['10-Q', '10-K']), None)

        if not report:
            print(f"⚠️ {symbol} 最近無財報，跳過。")
            supabase.table("tracked_stocks").update({"status": "no_report"}).eq("id", row_id).execute()
            return

        # Step 2: 抓取並清洗文字
        headers = {'User-Agent': 'MyInvestTool/1.0 (ryanlee940904@gmail.com)'}
        resp = requests.get(report['finalLink'], headers=headers)
        resp.encoding = 'utf-8'
        html = resp.text
        
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
        clean_text = re.sub(r'<[^>]*>', ' ', html)
        clean_text = re.sub(r'\s+', ' ', clean_text).strip()[:500000]

        # Step 3: 調用 AI 模型
        model = genai.GenerativeModel('gemini-2.5-flash')
        
        full_prompt = f"""
你是 {symbol} 公司的策略顧問。請閱讀這份 10-Q 財報的 MD&A（管理層討論）部分。

使用者不想看枯燥的財務報表數據，請你整理出「官方對於營運狀況的文字說明」，並幫助投資人快速判斷本季營運是否符合原本的長期成長方向。

請遵守以下規則：
1. 🚫 嚴禁羅列財務報表數據，除非該數字對理解 {symbol} 的策略是否成功至關重要。
2. 🗣️ 專注於「管理層的官方解釋」：營收變化原因、成本投入方向。
3. 🧭 每一段請先描述「官方說法」，再補充一句「對投資人的觀察含意」。
4. 🔮 請整理管理層對未來幾季的佈局與主要擔憂。
5. 🧠 避免行銷式語言，保持中性分析。

請使用以下結構，並以繁體中文輸出：
### 本季一句話營運判斷
### 1. 官方業務重點 (Business Highlights)
### 2. 成長與衰退的背後原因 (The "Why")
### 3. 公司的下一步 (Future Outlook)
### 4. 投資人接下來該觀察什麼

---
[文件內容]: {clean_text}
"""
        print(f"🤖 AI 分析中...")
        response = model.generate_content(full_prompt)
        summary = response.text

        # Step 4: 回填至資料庫，狀態設為 review
        supabase.table("tracked_stocks").update({
            "summary": summary,
            "status": "review"
        }).eq("id", row_id).execute()

        print(f"✅ {symbol} 處理完成。")

    except Exception as e:
        print(f"❌ 錯誤: {e}")

# === 主程式執行入口 ===
if __name__ == "__main__":
    print(f"⏰ 執行時間: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    try:
        # 抓取所有 pending 的資料，一次處理完
        response = supabase.table("tracked_stocks") \
            .select("*") \
            .eq("status", "pending") \
            .execute()
        
        pending_list = response.data
        
        if pending_list:
            print(f"🔎 發現 {len(pending_list)} 筆待處理資料")
            for stock in pending_list:
                process_stock(stock)
        else:
            print("📭 目前沒有 pending 的股票，結束執行。")
            
    except Exception as e:
        print(f"📡 連接資料庫失敗: {e}")