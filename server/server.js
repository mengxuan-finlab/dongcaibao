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
// ✅ Base / 免費版：Research Brief（看懂公司，但不做投資決策）
// 核心：資訊整合 + 條理 + 風險；禁止估值、勝率、買賣建議、星級評等
const getBasePrompt = (symbol, searchContext) => `
你將收到一段「搜尋結果」資料（可能含新聞、公司公告、產品資訊、財報摘要、評論等）。請先理解內容，再輸出一份給一般投資人閱讀的【公司研究簡報】。

【輸入資料】
${searchContext}

【角色設定】
你是一位資深產業研究員（sell-side research associate 等級）。語氣專業、清晰、條理分明，但不做投資建議。

【免費版定位（非常重要）】
- 目的：幫讀者「看懂」${symbol} 的業務、產品、競爭格局、風險與近期重點。
- 範圍：只做研究與拆解，不做決策。

【🚫 免費版嚴格禁止】
1) 禁止任何「估值」與「價格合理區間」推導（例如：便宜/昂貴、應該買、目標價、合理價）。
2) 禁止「勝率推測 / 情境報酬」與「投資評等」（買進/中立/賣出、星級）。
3) 禁止「建議買賣」與「進出場策略」。
4) 禁止引用標記（如 [1]、來源：XX）與免責聲明（不要寫「根據搜尋結果」）。

【允許的推論邊界】
- 可以做「專業推測」，但必須以「可能/傾向/暗示」表述，且推論要連結到：產品節奏、競爭態勢、公開市場行為（例如定價、渠道、合作、收購、使用者採用）。
- 不得把推論寫成確定事實。

【格式嚴格要求】
1) 大標題：# 一、核心摘要（單井號 + 空白）
2) 次標題：## 1.（雙井號 + 空白）
3) 重點用 **粗體**
4) 表格使用標準 Markdown 表格

【輸出結構（請嚴格照做）】

# 一、核心摘要
(200-260 字。直接交代：公司在做什麼、收入來源、最近的動能/壓力、研究重點。)

# 二、基本介紹
## 1. 關鍵發展節點
(3-5 個關鍵年份/事件，說明其戰略意義。)

## 2. 公司願景與路線圖
(若無明文願景，從產品/服務演進推導其企圖與優先順序。)

## 3. 主要產品與服務
(請用表格整理)
| 服務領域 | 核心產品類型 | 產品/服務範例 | 主要客群 |
| :--- | :--- | :--- | :--- |

## 4. 商業模式拆解
- **收入引擎**：（訂閱/交易抽成/廣告/硬體+耗材/服務費等）
- **客戶取得**：（渠道、合作夥伴、銷售模式）
- **留存與擴張**：（續約、加購、升級、交叉銷售）

## 5. 競爭優勢（不談估值）
(技術壁壘、品牌/渠道、生態系、資料優勢、成本結構、法規/認證等)

# 三、產業與競爭
## 1. 市場定位與主要競爭者（務必表格）
| 競爭者 | 核心定位 | 優勢 | 劣勢 | 對 ${symbol} 的威脅點 |
| :--- | :--- | :--- | :--- | :--- |

## 2. 產業趨勢與公司順風/逆風
(用 4-6 點條列，點出結構性趨勢與公司受益/受損之處)

# 四、風險清單（具體、可追蹤）
## 1. 三大核心風險
- **風險 1：**（具體到監管/供應鏈/技術替代/競爭價格戰等）
- **風險 2：**
- **風險 3：**

## 2. 觀察指標（Monitoring Checklist）
(列 6-10 個未來要追的指標：例如毛利率、ARPU、留存、產品良率、渠道擴張、重大訴訟、監管動向等；不要估值。)

# 五、下一步研究問題（留白鉤子）
(用 5-8 個問題列出「如果要做投資決策，還需要確認什麼」。不要寫答案，不要估值。)
`;

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

app.post('/lemonsqueezy-webhook', express.json(), async (req, res) => {
  try {
    const eventName = req.body.meta?.event_name;
    console.log("📩 收到事件:", eventName);

    const customData = req.body.meta?.custom_data;
    console.log("📦 custom_data 原始:", customData);

    let userId = null;

    // ✅ 情況 1：custom_data 是物件（你現在就是這個）
    if (customData && typeof customData === "object") {
      userId = customData.user_id;
    }

    // ✅ 情況 2：custom_data 是字串（保留相容）
    if (!userId && typeof customData === "string") {
      try {
        userId = JSON.parse(customData).user_id;
      } catch (e) {
        console.log("❌ custom_data JSON parse 失敗");
      }
    }

    console.log("👤 解析出的 user_id:", userId);

    if (!userId) {
      console.log("❌ 沒有 user_id，停止處理");
      return res.sendStatus(200);
    }

    const subscriptionId = req.body.data?.id;
    const status = req.body.data?.attributes?.status;

    console.log("📄 subscriptionId:", subscriptionId);
    console.log("📊 status:", status);

    const { data, error } = await supabase
      .from('profiles')
      .update({
        plan: status === 'active' ? 'pro' : 'free',
        subscription_id: subscriptionId,
        subscription_status: status
      })
      .eq('id', userId)
      .select('id,email,plan,subscription_id,subscription_status');

    console.log("🧾 Supabase update data:", data);
    console.log("🧾 Supabase update error:", error);

    if (!data || data.length === 0) {
      console.log("⚠️ 沒有任何資料列被更新 (可能 userId 不存在或連到錯專案)");
    } else {
      console.log("✅ Supabase 已成功更新方案");
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ Webhook 錯誤:", err);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`後端伺服器啟動中： http://localhost:${PORT}`);
});