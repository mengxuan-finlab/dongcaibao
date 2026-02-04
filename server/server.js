// server/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('@supabase/supabase-js');

const app = express();

// 允許跨網域請求
app.use(cors());
app.use(express.json());

// --- 初始化設定 ---

// 1. Supabase (使用 Service Role Key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. Gemini AI 設定
// 注意：目前最新且穩定的是 gemini-1.5-flash，使用 v1beta 通道
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash" 
}, { 
  apiVersion: "v1beta" 
});

// 方案限制設定
const PLAN_LIMIT = { free: 2, plus: 10, pro: Infinity };

// --- 這裡放 Prompt 產生器 (定義在路由外面) ---
const getBasePrompt = (symbol, searchContext) => `請閱讀以下的搜尋結果資料：
      ${searchContext}

      請根據上述「搜尋結果」，撰寫一份關於 "${symbol}" 的完整深度分析報告。

      【重要指令：你即將撰寫一份頂級華爾街研報】
      1. **角色設定**：你是一位擁有 20 年經驗的頂尖科技/金融分析師 (如 Goldman Sachs 或 Morgan Stanley 首席分析師)。你的語氣自信、專業、且具有洞察力。
      2. **深度推論 (關鍵)**：搜尋結果可能零散，你必須展現分析師的價值。若缺乏具體內部數據，請根據公司的「公開市場行為」、「產品發布歷史」和「競爭態勢」進行**專業推測 (Professional Inference)**。
      3. **嚴禁廢話**：絕對禁止寫出「受限於搜尋結果...」、「無法直接獲取...」等免責聲明。如果資料不夠，就用你的分析能力去填補空白。
      4. **語言**：請使用流暢、專業的**繁體中文 (Traditional Chinese)**。

      【🚫 格式禁忌與潔癖要求 (非常重要)】
      1. **嚴禁標註來源**：報告中**絕對不要**出現引用標記 (如 [1], (來源:XX))。請將資訊內化為流暢敘述。
      2. **嚴禁免責聲明**：不要寫「根據搜尋結果...」。請直接以專家口吻進行分析。

      【格式嚴格要求】
      1. **大標題**：使用 **單井號 + 空白** (例如：# 一、核心摘要)。
      2. **次標題**：使用 **雙井號 + 空白** (例如：## 1. 關鍵發展節點)。
      3. **重點強調**：關鍵字使用 **粗體** 包裹。
      4. **表格**：必須使用標準 Markdown 表格語法。

      【輸出目標結構 (請嚴格遵守此架構撰寫)】

      # 一、核心摘要
      (撰寫約 200-300 字摘要。簡述業務核心、商業模式亮點及最新財務動力。模仿分析師口吻，直接切入重點。)

      # 二、基本介紹
      ## 1. 關鍵發展節點
      (列出 3-5 個關鍵年份或事件，重點在於該事件對公司的戰略意義。)
      ## 2. 公司願景
      (他們想做什麼？若無明文願景，請根據產品路線圖推導其野心。)
      ## 3. 賣些什麼？
      (請整理成 Markdown 表格，欄位包含：服務領域、核心產品類型、產品/服務範例)
      ## 4. 業務與服務內容
      (詳細分析：1. 核心商業模式、2. 產品策略。請用條列式搭配粗體。)
      ## 5. 公司的競爭優勢
      (憑什麼贏？分析技術壁壘、品牌護城河或生態系優勢。)

      # 三、深入分析與風險
      ## 1. 市場定位與主要競爭者
      (列出 3 個主要競爭對手，並分析目標公司的對抗策略。**務必使用 Markdown 表格呈現**。)
      ## 2. 市場戰略
      (分析其定價策略、併購策略或生態系佈局。)
      ## 3. 市場與競爭力
      (包含：1. 產業趨勢、2. 關鍵競爭格局分析、3. 護城河深度剖析。)
      ## 4. 三大核心風險
      (具體指出監管、供應鏈或技術替代風險，不要寫籠統的「市場波動」。)
      ## 5. 管理層與公司治理
      (分析該公司的領導風格，例如「工程師文化」或「行銷導向」。)`;
// --- [Pro / 專業版] 建議指令：更硬核、更戰略 ---
const getProPrompt = (symbol, searchContext) => `
  請閱讀以下搜尋資料：${searchContext}
  你現在是頂尖對沖基金的首席投資官 (CIO)。請針對 "${symbol}" 撰寫一份專供【家族辦公室與高淨值客戶】參考的【深度戰略評級報告】。

  【🚫 報告三大禁忌】
  1. 拒絕普及知識：不要解釋產品，直接分析產品在供應鏈中的「毛利定價權」。
  2. 拒絕模糊結論：不要說「視市場而定」，請給出你的「核心假設」與「勝率推測」。
  3. 拒絕免責聲明：用數據和邏輯內化觀點，直接給出專業判斷。

  # ⚖️ ${symbol} 機構級深度投資評等報告

  ## 一、 核心投資策略 (High-Conviction Thesis)
  (點出市場目前對該公司的「主流誤解」是什麼，以及你觀察到的「價值拐點」。)

  ## 二、 產業生態鏈與議價權量化
  | 鏈條位置 | 議價權等級(1-5) | 關鍵廠商對抗策略 | 結構性轉向分析 |
  | :--- | :--- | :--- | :--- |

  ## 三、 護城河量化評級 (Economic Moat)
  (針對：無形資產、網絡效應、轉換成本、成本優勢 給予 1-5 星評等並說明理由。)

  ## 四、 估值分析與邊際安全 (Valuation & Margin of Safety)
  (分析當前估值與歷史區間的關係。若發生極端市況，該公司的財務防禦力如何？)

  ## 五、 資本配置實力 (Capital Allocation)
  (管理層對現金流的運用效率分析：研發投入 vs. 股東回報 vs. 債務槓桿。)

  ## 六、 牛熊情境演練 (Scenario Analysis)
  ### 1. 📈 牛市路徑 (Bull Case)：催化劑觸發後的增長天花板。
  ### 2. 📉 熊市預警 (Bear Case)：關鍵風險爆發時的防禦底線。
`;
// --- 主要 API ---
// --- 主要 API ---
app.post('/api/analyze-stock', async (req, res) => {
  const { symbol } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: '未登入' });
  
  try {
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) throw new Error('身分驗證失敗');

    const { data: profile } = await supabase.from('profiles').select('plan').eq('id', user.id).single();
    
    // --- ★ 關鍵修正 1：統一轉小寫，防止 PRO/pro 判定錯誤 ---
    const userPlan = (profile?.plan || 'free').toLowerCase();
    const isPro = (userPlan === 'pro');

    // ==========================================
    // ★ 新增：限流攔截器 (放在搜尋之前)
    // ==========================================
    
    // 1. 計算本週起始時間 (週日凌晨)
    const startOfWeek = new Date();
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    // 2. 向 Supabase 查詢該用戶本週已使用次數
    const { count: usedCount, error: countError } = await supabase
      .from("usage_logs")
      .select("*", { count: 'exact', head: true })
      .eq("user_id", user.id)
      .eq("action", "company_intro")
      .gte("created_at", startOfWeek.toISOString());

    if (countError) throw new Error("無法讀取使用紀錄");

    // 3. 檢查是否超過限制 (Pro 方案為 Infinity，永遠不會進入此 if)
    const limit = PLAN_LIMIT[userPlan] || 2;
    if (usedCount >= limit) {
      return res.status(403).json({ 
        error: `已達本週使用上限。您的 ${userPlan} 方案額度為每週 ${limit} 次，請升級方案以繼續使用。`,
        plan: userPlan 
      });
    }
    // ==========================================
    // 往下才是原本的執行邏輯 (通過檢查才執行)
    // ==========================================

    // --- ★ 關鍵修正 2：修正模型名稱 (Gemini 無 2.5 版本) ---
    const modelName = isPro ? "gemini-2.5-flash" : "gemini-2.5-flash"; 
    const searchNum = isPro ? 20 : 10;

    // 診斷用：請在部署後的 Log 觀察這裡輸出什麼
    console.log(`[系統診斷] 用戶方案: ${userPlan} | 調用模型: ${modelName} | 是否為 Pro 模式: ${isPro}`);

    // A. 搜尋階段
    const searchQuery = `${symbol} stock business model competitive advantage risks analysis`;
    const serpApiUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${process.env.SERPAPI_KEY}&num=${searchNum}&hl=zh-tw&gl=tw`;
    
    const searchResponse = await axios.get(serpApiUrl);
    const searchResults = searchResponse.data.organic_results || [];

    const searchContext = searchResults.map((item, index) => 
      `[資料 ${index + 1}] ${item.title}: ${item.snippet}`
    ).join("\n\n");

    // B. 選擇 Prompt (確認調用外部定義的函數)
    const finalPrompt = isPro 
      ? getProPrompt(symbol, searchContext) 
      : getBasePrompt(symbol, searchContext);

    // C. 呼叫動態模型
    const dynamicModel = genAI.getGenerativeModel({ model: modelName });
    const aiResult = await dynamicModel.generateContent(finalPrompt);
    const responseText = aiResult.response.text();

    await supabase.from('usage_logs').insert({ user_id: user.id, action: 'company_intro' });

    res.json({ 
      text: responseText, 
      plan: userPlan 
    });

  } catch (err) {
    console.error("後端錯誤:", err);
    res.status(500).json({ error: err.message || '伺服器忙碌中' });
  }
});
// === 額外：Stock Data Supabase（讀 core_metrics 用）===
const sbData = createClient(
  process.env.SB_DATA_URL,          // 你的股票資料庫 URL
  process.env.SB_DATA_SERVICE_KEY   // 你的股票資料庫 Service Role Key
);

// 小工具：從 token 取 user + plan
async function getUserAndPlanFromToken(token) {
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) throw new Error('身分驗證失敗');

  // 查 core_metrics（股票資料庫）
  const { data, error: dataErr } = await sbData
    .from("core_metrics")
    .select("gross_margin, operating_margin, roic")
    .eq("symbol", symbol)
    .single();

  if (profileError) throw new Error('讀取方案失敗');
  return { user, plan: profile?.plan || 'free' };
}

// ===== Pro-only 指標 API =====
// 後端 (server.js)
app.get('/api/pro-metrics', async (req, res) => {
  try {
    const { symbol } = req.query;
    const authHeader = req.headers.authorization;
    const FMP_KEY = process.env.FMP_API_KEY;

    if (!authHeader) return res.status(401).json({ error: "未登入" });

    // 1. 權限與方案驗證
    const token = authHeader.split(" ")[1];
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    const { data: profile } = await supabase.from("profiles").select("plan").eq("id", user.id).single();
    if (profile?.plan !== "pro") return res.status(403).json({ error: "限 Pro 方案解鎖高品質趨勢" });

    // 2. 抓取五年歷史數據 (使用 Stable 端點)
    const [kmRes, ratioRes] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/stable/key-metrics?symbol=${symbol}&apikey=${FMP_KEY}`),
      axios.get(`https://financialmodelingprep.com/stable/ratios?symbol=${symbol}&apikey=${FMP_KEY}`)
    ]);

    // 1. 先進行降序排序 (最新的日期在 index 0)
    const sortedKm = kmRes.data.sort((a, b) => new Date(b.date) - new Date(a.date));
    const sortedRatio = ratioRes.data.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 2. 取前 5 筆最新的資料
    // 3. 使用 reverse() 轉回 2021 -> 2025 的順序，供圖表從左到右繪製
    const kmFull = sortedKm.slice(0, 5).reverse(); 
    const ratioFull = sortedRatio.slice(0, 5).reverse();

    // 4. 定義最新的一筆資料 (Snapshot 使用)
    const latestKm = kmFull[kmFull.length - 1] || {};
    const latestRatio = ratioFull[ratioFull.length - 1] || {};
    // --- 關鍵修正：在這裡計算最新一年的 FCF Margin ---
    // 優先使用 ratio 的比率相乘，若無則用每股數值相除
    const latestFcfMargin = 
      (latestRatio.operatingCashFlowSalesRatio * latestRatio.freeCashFlowOperatingCashFlowRatio) || 
      (latestRatio.freeCashFlowPerShare / latestRatio.revenuePerShare) || 
      (latestKm.freeCashFlowYield * latestRatio.priceToSalesRatio) || 0;
    
    // 3. 回傳整合後的格式
    res.json({
      symbol,
      snapshot: {
        roic: latestKm.returnOnCapitalEmployed,         // 51.97%
        ccc: latestKm.cashConversionCycle,              // -41.97 天
        operating_margin: latestRatio.operatingProfitMargin, 
        net_debt_to_ebitda: latestKm.netDebtToEBITDA,   // 0.55
        fcf_yield: latestKm.freeCashFlowYield,          // 2.59%
        ev_ebitda: latestKm.evToEBITDA, 
        pe: latestRatio.priceToEarningsRatio,      //
        p_fcf: latestRatio.priceToFreeCashFlowRatio, //  
        fcfMargin: latestFcfMargin             
      },
      history: kmFull.map((km, i) => {
        const r = ratioFull[i] || {};
        // --- 新增：計算每一年的 FCF Margin (用於折線圖) ---
        const historyFcfMargin = 
          (r.operatingCashFlowSalesRatio * r.freeCashFlowOperatingCashFlowRatio) || 
          (r.freeCashFlowPerShare / r.revenuePerShare) || 0;
        return {
          year: km.date.slice(0, 4),
          roic: km.returnOnCapitalEmployed,
          operatingMargin: r.operatingProfitMargin,
          grossMargin: r.grossProfitMargin,
          ccc: km.cashConversionCycle,
          pe: r.priceToEarningsRatio,      //
          p_fcf: r.priceToFreeCashFlowRatio,
          fcfMargin: historyFcfMargin // 傳給前端歷史陣列
        };
      })
    });
  } catch (e) {
    console.error("[Pro API Error]", e.message);
    res.status(500).json({ error: "抓取數據失敗，請確認 API Key 有效性" });
  }
});

app.get("/api/fmp/income-statement", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    if (!/^[A-Z.\-]{1,10}$/.test(symbol)) {
      return res.status(400).json({ error: "Bad symbol" });
    }

    const url = `https://financialmodelingprep.com/stable/income-statement?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(process.env.FMP_API_KEY)}`;
    const r = await fetch(url);
    const data = await r.json();

    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/fmp/cash-flow-statement", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    if (!/^[A-Z.\-]{1,10}$/.test(symbol)) {
      return res.status(400).json({ error: "Bad symbol" });
    }

    const url = `https://financialmodelingprep.com/stable/cash-flow-statement?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(process.env.FMP_API_KEY)}`;
    const r = await fetch(url);
    const data = await r.json();

    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
});

app.post('/lemonsqueezy-webhook', async (req, res) => {
    const event = req.body;
    const eventName = event.meta?.event_name;
    
    // 💡 修正：正確抓取我們剛剛傳過去的 user_id
    const userId = event.meta?.custom_data?.user_id || event.meta?.passthrough?.user_id;
    
    console.log(`[收到 Webhook] 事件: ${eventName}, 用戶ID: ${userId}`);

    // 處理訂閱成功 (subscription_created) 或 更新 (subscription_updated)
    if (userId && (eventName?.includes('subscription') || eventName?.includes('order'))) {
        
        const variantName = event.data?.attributes?.variant_name || "";
        
        // 💡 修正：用關鍵字判斷，只要名稱有 "pro" 就給 pro 權限，否則給 plus
        const planToUpdate = variantName.toLowerCase().includes('pro') ? 'pro' : 'plus';

        // 💡 提醒：這裡一定要用 service_role 的 supabaseAdmin，才能無視 RLS 修改資料
        const { error } = await supabaseAdmin
            .from('profiles')
            .update({ plan: planToUpdate })
            .eq('id', userId);

        if (error) {
            console.error('❌ Supabase 更新失敗:', error.message);
        } else {
            console.log(`✅ 更新成功！用戶 ${userId} 現在是 ${planToUpdate} 會員`);
        }
    }
    
    // 不論成功失敗都回傳 200 給 Lemon Squeezy，避免它一直重傳
    res.status(200).send('OK');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`後端伺服器啟動中： http://localhost:${PORT}`);
});