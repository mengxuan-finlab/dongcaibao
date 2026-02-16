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

# --- [新加入：爬蟲套件] ---
from newspaper import Article

# ==========================================
# 🔑 設定區
# ==========================================
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_MAIN") 
FMP_API_KEY = os.getenv("FMP_API_KEY")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD")

if not all([SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, FMP_API_KEY, ADMIN_EMAIL, EMAIL_PASSWORD]):
    print("❌ 錯誤：無法讀取環境變數！")
    exit() 

# ==========================================
# 🚀 初始化
# ==========================================
try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    genai.configure(api_key=GEMINI_API_KEY)
except Exception as e:
    print(f"❌ 初始化失敗: {e}")
    exit()

# --- [新功能：抓取全文] ---
def fetch_full_content(url):
    """前往 URL 爬取整篇新聞正文"""
    try:
        article = Article(url, language='en')
        article.download()
        article.parse()
        content = article.text
        return content if len(content) > 200 else None
    except Exception as e:
        print(f"⚠️ 爬取全文失敗 (可能被擋): {e}")
        return None

def get_rules_from_db():
    """從資料庫讀取規則，只抓取已啟用的規則 (is_active = True)"""
    print("正在連線 Supabase 讀取啟用的規則與方案資料...")
    try:
        # 修改點：使用 .eq('is_active', True) 直接在資料庫層級過濾
        response = supabase.table('news_tracking_rules') \
            .select('*, profiles(email, plan)') \
            .eq('is_active', True) \
            .execute()
        
        rules = []
        for item in response.data:
            # 處理關鍵字
            raw_kw = item.get('keywords', '')
            if not raw_kw: continue
            kw_list = [k.strip().lower() for k in raw_kw.split(',') if k.strip()]
            
            # 獲取用戶資料
            profile = item.get('profiles', {})
            client_email = profile.get('email')
            user_plan = profile.get('plan', 'free').lower()
            
            target_email = client_email if client_email else ADMIN_EMAIL

            rules.append({
                'keywords': kw_list,
                'reason': item.get('reason', '無特定理由'),
                'target_email': target_email,
                'plan': user_plan
            })
            
        print(f"✅ 成功讀取 {len(rules)} 條啟用的規則。")
        return rules
    except Exception as e:
        print(f"⚠️ 讀取規則失敗: {e}")
        return []

# (is_url_processed, mark_url_processed, fetch_news 保持不變...)
def is_url_processed(url):
    try:
        res = supabase.table('processed_news').select('url').eq('url', url).execute()
        return len(res.data) > 0
    except: return False

def mark_url_processed(url, title):
    try:
        supabase.table('processed_news').insert({'url': url, 'title': title}).execute()
    except: pass

def fetch_news():
    url = f"https://financialmodelingprep.com/stable/news/stock-latest?page=0&limit=20&apikey={FMP_API_KEY}"
    try:
        response = requests.get(url)
        return response.json() if response.status_code == 200 else []
    except: return []

def analyze_and_send(news_item, rule):
    """AI 分析並寄信 (Pro 方案將啟動全文分析)"""
    model = genai.GenerativeModel('gemini-2.5-flash')
    
    user_plan = rule.get('plan', 'free')
    keywords_str = ", ".join(rule['keywords'])
    
    # --- [分流邏輯] ---
    if user_plan == "pro":
        print(f"🌟 Pro 用戶 ({rule['target_email']}): 啟動爬蟲抓取全文...")
        full_text = fetch_full_content(news_item['url'])
        if full_text:
            content_to_ai = full_text
            analysis_type = "【Pro 深度全文分析模式】"
        else:
            content_to_ai = news_item['text']
            analysis_type = "【Pro 模式 (全文抓取受限，改用摘要)】"
    else:
        print(f"👤 Free/Plus 用戶 ({rule['target_email']}): 使用摘要分析...")
        content_to_ai = news_item['text']
        analysis_type = "【標準摘要分析模式】"

    prompt = f"""
    你是一位專業投資助理。目前正在執行：{analysis_type}
    【客戶監控理由】：{rule['reason']}
    【監控關鍵字】：{keywords_str}

    【新聞標題】：{news_item['title']}
    【新聞原文內容】：
    {content_to_ai}

    請以 JSON 格式回傳分析結果：
    {{
        "chinese_summary": "繁體中文一句話摘要(50字內)",
        "html_report": "HTML代碼(包含<h2>二、關聯分析</h2>與<h2>三、完整翻譯與重點標註</h2>)"
    }}
    """

    try:
        response = model.generate_content(prompt)
        text_resp = response.text.replace("```json", "").replace("```", "").strip()
        ai_result = json.loads(text_resp)

        # 組裝 Email 模板
        today = datetime.now().strftime("%Y-%m-%d")
        subject = f"🔔 {analysis_type} {ai_result.get('chinese_summary')[:15]}..."

        # 在 HTML 中加入方案識別
        plan_badge = '<span style="background:#ffd700; color:#000; padding:2px 6px; border-radius:4px;">PRO</span>' if user_plan == 'pro' else ''

        html_body = f"""
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
            <h2>懂才抱投資快訊 {plan_badge}</h2>
            <p style="font-size:12px; color:#666;">分析模式: {analysis_type} | 日期: {today}</p>
            <div style="background:#f0f9ff; padding:12px; border-left:4px solid #0ea5e9; margin: 15px 0;">
                <strong>追蹤關鍵字：</strong> {keywords_str}<br>
                <strong>您的筆記：</strong> {rule['reason']}
            </div>
            <h3 style="color:#1e40af;">{news_item['title']}</h3>
            <div style="background:#fff7ed; padding:12px; border-left:4px solid #f97316; margin: 15px 0;">
                <strong>AI 核心摘要：</strong> {ai_result.get('chinese_summary')}
            </div>
            <hr style="border:0; border-top:1px solid #eee;">
            {ai_result.get('html_report')}
            <br>
            <p style="text-align:center;"><a href="{news_item['url']}" style="color:#0ea5e9;">閱讀原始新聞連結</a></p>
            <div style="text-align:center; font-size:11px; color:#999; margin-top:30px; border-top: 1px solid #eee; padding-top:10px;">
                懂才抱 AI 自動追蹤系統 | 專為 {user_plan.upper()} 方案提供
            </div>
        </div>
        """

        msg = MIMEMultipart()
        msg['From'] = ADMIN_EMAIL
        msg['To'] = rule['target_email']
        msg['Subject'] = subject
        msg.attach(MIMEText(html_body, 'html'))

        server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        server.login(ADMIN_EMAIL, EMAIL_PASSWORD)
        server.send_message(msg)
        server.quit()
        print(f"✅ Email 已寄出 ({user_plan})")

        mark_url_processed(news_item['url'], news_item['title'])

    except Exception as e:
        print(f"❌ 處理失敗: {e}")

def main():
    print("=== 🚀 懂才抱新聞機器人 (方案分流版) 啟動 ===")
    rules = get_rules_from_db()
    if not rules: return
    
    all_news = fetch_news()
    processed_count = 0
    
    for news in all_news:
        url = news.get('url')
        if is_url_processed(url): continue
            
        content_low = (news.get('title', '') + " " + news.get('text', '')).lower()
        for rule in rules:
            if any(k in content_low for k in rule['keywords']):
                analyze_and_send(news, rule)
                processed_count += 1
                break 
    print(f"\n✅ 執行完畢，共處理 {processed_count} 則任務。")

if __name__ == "__main__":
    main()