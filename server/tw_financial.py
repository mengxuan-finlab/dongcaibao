import os
from datetime import datetime, timedelta

import google.generativeai as genai
import requests
from dotenv import load_dotenv
from supabase import create_client


load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GEMINI_API_MAIN")
FINMIND_TOKEN = os.getenv("FINMIND_TOKEN")

genai.configure(api_key=GEMINI_API_KEY)
supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def normalize_tw_symbol(symbol):
    value = str(symbol or "").strip().upper()
    if value.endswith(".TW") or value.endswith(".TWO"):
        value = value.split(".")[0]
    return value


def is_tw_stock(symbol):
    value = normalize_tw_symbol(symbol)
    return value.isdigit() and len(value) == 4


def safe_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def format_pct(value):
    if value is None:
        return "無法計算"
    return f"{value:.2f}%"


def format_revenue_yi(value):
    number = safe_float(value)
    if number is None:
        return "未披露"
    # FinMind TaiwanStockMonthRevenue 的 revenue 通常為仟元；換算為新台幣億元。
    return f"{number / 100000:.2f} 億元"


def fetch_monthly_revenue(symbol):
    stock_id = normalize_tw_symbol(symbol)
    start_date = (datetime.now() - timedelta(days=820)).strftime("%Y-%m-%d")
    params = {
        "dataset": "TaiwanStockMonthRevenue",
        "data_id": stock_id,
        "start_date": start_date,
    }
    if FINMIND_TOKEN:
        params["token"] = FINMIND_TOKEN

    response = requests.get("https://api.finmindtrade.com/api/v4/data", params=params, timeout=30)
    response.raise_for_status()
    payload = response.json()

    if payload.get("status") not in (200, "200"):
        raise RuntimeError(payload.get("msg") or "FinMind API 回傳異常")

    rows = payload.get("data") or []
    rows = [row for row in rows if str(row.get("stock_id")) == stock_id]
    rows.sort(key=lambda row: row.get("date", ""))
    return rows[-24:]


def enrich_monthly_rows(rows):
    by_month = {row.get("date"): row for row in rows}
    enriched = []

    for index, row in enumerate(rows):
        revenue = safe_float(row.get("revenue"))
        previous_revenue = safe_float(rows[index - 1].get("revenue")) if index > 0 else None

        current_date = row.get("date", "")
        try:
            previous_year_date = datetime.strptime(current_date, "%Y-%m-%d").replace(
                year=datetime.strptime(current_date, "%Y-%m-%d").year - 1
            ).strftime("%Y-%m-%d")
        except ValueError:
            previous_year_date = ""

        last_year_revenue = safe_float(by_month.get(previous_year_date, {}).get("revenue"))
        mom = ((revenue - previous_revenue) / previous_revenue * 100) if revenue and previous_revenue else None
        yoy = ((revenue - last_year_revenue) / last_year_revenue * 100) if revenue and last_year_revenue else None

        enriched.append({
            "date": current_date,
            "revenue": revenue,
            "revenue_yi": format_revenue_yi(revenue),
            "mom": mom,
            "yoy": yoy,
        })

    return enriched


def build_revenue_context(enriched_rows):
    recent_rows = enriched_rows[-12:]
    latest = enriched_rows[-1]
    previous = enriched_rows[-2] if len(enriched_rows) >= 2 else None

    latest_12_sum = sum(row["revenue"] or 0 for row in recent_rows)
    previous_12_rows = enriched_rows[-24:-12]
    previous_12_sum = sum(row["revenue"] or 0 for row in previous_12_rows)
    ttm_yoy = (
        (latest_12_sum - previous_12_sum) / previous_12_sum * 100
        if previous_12_sum
        else None
    )

    rows_text = "\n".join(
        f"- {row['date']}：營收 {row['revenue_yi']}，MoM {format_pct(row['mom'])}，YoY {format_pct(row['yoy'])}"
        for row in recent_rows
    )

    return {
        "latest": latest,
        "previous": previous,
        "ttm_yoy": ttm_yoy,
        "rows_text": rows_text,
    }


def generate_summary(symbol, enriched_rows):
    context = build_revenue_context(enriched_rows)
    model = genai.GenerativeModel("gemini-2.5-flash")

    prompt = f"""
你是一位熟悉台股月營收與產業循環的研究員。

任務：
請根據以下台股月營收資料，整理一份給一般投資人閱讀的「台股月營收趨勢分析」。
這不是買賣建議，也不是完整財報分析；重點是幫使用者理解營收動能、年增/月增變化、季節性與後續追蹤方向。

輸出規則：
- 使用繁體中文
- 第一行直接從標題開始，不要開場白
- 不要提供買進、賣出、目標價或投資評等
- 若資料不足，請明確寫「目前資料不足以判斷」
- 不要假裝知道公司產品或產業細節；若需要補充，只能以「需搭配公司產業資料確認」表述
- 請使用 Markdown 標題，讓前端可以切成投影片

請使用以下格式：

### 台股月營收重點摘要
### 1. 近期營收趨勢
### 2. 年增率與月增率變化
### 3. 可能的季節性或循環訊號
### 4. 後續追蹤重點
### 5. 目前資料限制

股票代號：{symbol}
近 12 個月累計營收年增率：{format_pct(context["ttm_yoy"])}

近 12 個月月營收資料：
{context["rows_text"]}
"""

    response = model.generate_content(prompt)
    return response.text


def process_stock(stock_row):
    raw_symbol = stock_row["symbol"]
    symbol = normalize_tw_symbol(raw_symbol)
    row_id = stock_row["id"]

    if not is_tw_stock(raw_symbol):
        return

    print(f"🚀 開始處理台股：{raw_symbol} (ID: {row_id})")

    try:
        rows = fetch_monthly_revenue(symbol)
        if len(rows) < 6:
            print(f"⚠️ {raw_symbol} 月營收資料不足，跳過。")
            supabase.table("tracked_stocks").update({"status": "no_report"}).eq("id", row_id).execute()
            return

        enriched_rows = enrich_monthly_rows(rows)
        summary = generate_summary(symbol, enriched_rows)

        supabase.table("tracked_stocks").update({
            "summary": summary,
            "status": "tw_review",
            "report_url": None,
        }).eq("id", row_id).execute()

        print(f"✅ 台股 {raw_symbol} 處理完成。")

    except Exception as error:
        print(f"❌ 台股 {raw_symbol} 處理失敗: {error}")


if __name__ == "__main__":
    print(f"⏰ 台股財務追蹤執行時間: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    try:
        response = supabase.table("tracked_stocks") \
            .select("*") \
            .eq("status", "pending") \
            .execute()

        pending_list = response.data or []
        tw_pending = [stock for stock in pending_list if is_tw_stock(stock.get("symbol"))]

        if not tw_pending:
            print("📭 目前沒有 pending 的台股，結束執行。")
        else:
            print(f"🔎 發現 {len(tw_pending)} 筆台股待處理資料")
            for stock in tw_pending:
                process_stock(stock)

    except Exception as error:
        print(f"📡 連接資料庫失敗: {error}")
