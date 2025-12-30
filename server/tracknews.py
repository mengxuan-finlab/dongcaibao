import os
import json
import requests
import smtplib
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import google.generativeai as genai
from supabase import create_client, Client
from dotenv import load_dotenv

# ==========================================
# 🔑 設定區 (請確認這裡的資料正確)
# ==========================================

# 1. 載入 .env 檔案裡的設定
load_dotenv()

# 2. 讀取變數 (如果讀不到會是 None)
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_MAIN") 
FMP_API_KEY = os.getenv("FMP_API_KEY")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")

# 3. 防呆檢查 (怕您 .env 忘記存檔或寫錯)
if not all([SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, FMP_API_KEY, ADMIN_EMAIL, EMAIL_PASSWORD]):
    print("❌ 錯誤：無法讀取環境變數！")
    print("請檢查您的 .env 檔案是否包含所有必要的設定 (SUPABASE_KEY, GEMINI_API_KEY...等)")
    print("並確認 .env 檔案與 news.py 在同一個資料夾下。")
    exit() 

# ==========================================
# 🚀 主程式邏輯 (以下都不用改)
# ==========================================

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    genai.configure(api_key=GEMINI_API_KEY)
except Exception as e:
    print(f"❌ 初始化失敗: {e}")
    exit()

def get_rules_from_db():
    """從資料庫讀取規則，並透過 user_id 自動抓取 profiles 裡的 email"""
    print("正在連線 Supabase 讀取規則與用戶資料...")
    try:
        # 使用關聯查詢，抓取 profiles 裡的 email
        response = supabase.table('news_tracking_rules').select('*, profiles(email)').execute()
        
        rules = []
        for item in response.data:
            # 處理關鍵字
            raw_kw = item.get('keywords', '')
            if not raw_kw: continue
            kw_list = [k.strip().lower() for k in raw_kw.split(',') if k.strip()]
            
            # 自動抓取關聯的 Email
            client_email = None
            if item.get('profiles') and item['profiles'].get('email'):
                client_email = item['profiles']['email']
            
            # ✅ 如果抓不到客戶 Email，就使用上面定義的 ADMIN_EMAIL
            target_email = client_email if client_email else ADMIN_EMAIL

            rules.append({
                'keywords': kw_list,
                'reason': item.get('reason', '無特定理由'),
                'target_email': target_email 
            })
            
        return rules
    except Exception as e:
        print(f"⚠️ 讀取規則失敗: {e}")
        return []

def is_url_processed(url):
    """檢查新聞是否已處理過"""
    try:
        res = supabase.table('processed_news').select('url').eq('url', url).execute()
        return len(res.data) > 0
    except:
        return False

def mark_url_processed(url, title):
    """標記新聞為已處理"""
    try:
        supabase.table('processed_news').insert({
            'url': url,
            'title': title
        }).execute()
        print(f"📝 已記錄到資料庫: {title[:10]}...")
    except Exception as e:
        print(f"⚠️ 寫入紀錄失敗: {e}")

def fetch_news():
    """抓取最新新聞"""
    url = f"https://financialmodelingprep.com/stable/news/stock-latest?page=0&limit=20&apikey={FMP_API_KEY}"
    print(f"正在抓取新聞來源...")
    try:
        response = requests.get(url)
        return response.json() if response.status_code == 200 else []
    except Exception as e:
        print(f"網路連線錯誤: {e}")
        return []

def analyze_and_send(news_item, rule):
    """AI 分析並寄信"""
    model = genai.GenerativeModel('gemini-2.5-flash')
    
    keywords_str = ", ".join(rule['keywords'])
    target_email = rule['target_email'] 

    print(f"🤖 AI 分析中... (將寄給: {target_email})")

    prompt = f"""
    你是一位專業投資助理。
    【客戶持股/監控理由】：{rule['reason']}
    【監控關鍵字】：{keywords_str}

    【新聞標題】：{news_item['title']}
    【新聞內文】：{news_item['text']}

    請以 JSON 格式回傳分析結果：
    {{
        "chinese_summary": "繁體中文一句話摘要(50字內)",
        "html_report": "HTML代碼(包含<h2>二、關聯分析</h2>與<h2>三、完整翻譯，重點句請標色</h2>)"
    }}
    """

    try:
        response = model.generate_content(prompt)
        text_resp = response.text.replace("```json", "").replace("```", "").strip()
        ai_result = json.loads(text_resp)

        # 組裝 Email
        today = datetime.now().strftime("%Y-%m-%d")
        subject = f"🔔 投資快訊 ({keywords_str})：{ai_result.get('chinese_summary')[:15]}..."

        html_body = f"""
        <h2>投資快訊</h2>
        <p style="font-size:12px; color:#666;">日期: {today}</p>
        <div style="background:#f0f9ff; padding:10px; border-left:4px solid #0ea5e9; margin-bottom:15px;">
            <strong>觸發規則：</strong> {keywords_str}<br>
            <strong>您的筆記：</strong> {rule['reason']}
        </div>
        <p><strong>新聞標題：</strong> {news_item['title']}</p>
        <div style="background:#fff7ed; padding:10px; border-left:4px solid #f97316; margin-bottom:15px;">
            <strong>AI 摘要：</strong> {ai_result.get('chinese_summary')}
        </div>
        <hr>
        {ai_result.get('html_report')}
        <br>
        <p><a href="{news_item['url']}">閱讀原文</a></p>
        <div style="text-align:center; font-size:12px; color:#999; margin-top:20px;">
            Generated by Python Backend
        </div>
        """

        msg = MIMEMultipart()
        msg['From'] = ADMIN_EMAIL
        msg['To'] = target_email 
        msg['Subject'] = subject
        msg.attach(MIMEText(html_body, 'html'))

        server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        # ✅ 這裡使用 ADMIN_EMAIL 登入
        server.login(ADMIN_EMAIL, EMAIL_PASSWORD)
        server.send_message(msg)
        server.quit()
        print(f"✅ Email 已寄出給: {target_email}")

        mark_url_processed(news_item['url'], news_item['title'])

    except Exception as e:
        print(f"❌ 處理失敗: {e}")

def main():
    print("=== 🚀 新聞追蹤機器人 (GitHub Actions 版) 啟動 ===")
    
    # 1. 讀取規則
    rules = get_rules_from_db()
    if not rules:
        print("⚠️ 無法讀取規則，結束。")
        return
    print(f"已讀取 {len(rules)} 組規則。")

    # 2. 抓取新聞
    all_news = fetch_news()
    print(f"抓到 {len(all_news)} 則新聞，開始比對...")
    
    processed_count = 0
    for news in all_news:
        news_url = news.get('url')
        if is_url_processed(news_url):
            continue
            
        news_content = (news.get('title', '') + " " + news.get('text', '')).lower()
        
        for rule in rules:
            if any(k in news_content for k in rule['keywords']):
                print(f"\n⚡ 發現目標！新聞: {news['title'][:30]}...")
                analyze_and_send(news, rule)
                processed_count += 1
                break 
    
    if processed_count == 0:
        print("\n✅ 掃描完成，沒有符合的新聞。")
    else:
        print(f"\n✅ 掃描完成，共發送 {processed_count} 封報告。")


if __name__ == "__main__":
    main()