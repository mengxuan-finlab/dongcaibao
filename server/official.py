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
你是一個財報文件摘要助手。

任務：
請根據公司 10-Q / 10-K 財報中 MD&A（管理層討論與分析）段落，
整理管理層對本期營運狀況的官方描述，使內容更容易閱讀。

⚠️ 輸出規則（必須嚴格遵守）：
- 不得輸出任何開場白、角色描述或任務說明
- 第一行必須直接從標題開始
- 不得提供投資建議或營運優劣評價
- 避免使用「強勁、疲弱、成功、惡化、樂觀」等主觀形容詞
- 僅整理管理層在文件中提及的原因、行動與未來規劃
- 若需要補充說明，只能使用中性描述，例如：
  「文件顯示公司正在…」「管理層指出…」

⚠️ 財務數字處理：
- 原則上避免羅列財務數據
- 僅在該數據對理解公司營運方向具有關鍵意義時簡要提及

請使用以下格式（繁體中文）：

### 本期官方營運重點摘要
### 1. 官方業務發展重點
### 2. 營運變動的管理層說明
### 3. 管理層提及的未來規劃
### 4. 文件中揭露的主要風險或不確定性

---
[MD&A 文件內容]
{clean_text}
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