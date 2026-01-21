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
  你現在是頂尖對沖基金的資深分析師。請針對 "${symbol}" 撰寫【深度戰略評級報告】。

  【🚫 嚴格要求】
  1. 拒絕百科資訊：嚴禁寫公司歷史、願景或基礎產品介紹。
  2. 專注戰略：直接切入議價權、護城河與未來催化劑。
  3. 語氣冷靜專業：不要免責聲明，直接給出你的判斷。

  # ⚖️ ${symbol} 深度戰略投資評等報告

  ## 一、 核心投資策略 (Investment Thesis)
  (直接點出該公司目前最核心的「獲利變局」與市場尚未察覺的潛力或風險。)

  ## 二、 產業鏈生態位與議價權
  (請使用 Markdown 表格，分析上游供應商、主要客戶、替代者的議價權)
  | 角色 | 關鍵廠商 | 議價權評級 | 戰略影響力分析 |
  | :--- | :--- | :--- | :--- |

  ## 三、 護城河量化評級 (Economic Moat)
  (針對：1.無形資產 2.轉換成本 3.網絡效應 4.成本優勢 給予 1-5 星評等並解釋。)

  ## 四、 未來 12 個月關鍵催化劑 (Catalysts)
  (具體列出 3 個可能導致股價重估的具體事件。)

  ## 五、 牛熊情境分析 (Scenario Analysis)
  ### 1. 📈 牛市路徑 (Bull Case) - 觸發條件與增長天花板
  ### 2. 📉 熊市預警 (Bear Case) - 關鍵風險與防禦底線
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`後端伺服器啟動中： http://localhost:${PORT}`);
});