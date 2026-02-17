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
const getBasePrompt = (symbol, searchContext) => `
你將收到一段「搜尋結果」資料。請內化事實後，輸出一份給投資人閱讀的【公司研究簡報】。

==============================
【輸入資料】
${searchContext}
==============================

【角色設定】
你是一位資深產業研究員。語氣專業、具分析框架、數據導向。

==============================
【🚫 絕對禁令：違反則報告作廢】
1) 嚴禁使用任何資料標記：禁止出現如「(資料 1)」、「根據資料 5」、「(來源 3)」或任何括號數字。
2) 嚴禁使用免責聲明：不要寫「投資有風險」、「以上僅供參考」。
3) 嚴禁空泛口號：禁止使用「數位轉型」、「強化優勢」等虛詞，必須具體寫出做法（例如：提供 GPU 算力租賃）。
4) 嚴禁投資建議：禁止給出目標價、買進/賣出建議。

==============================
【工作流程】
Step 0：資料除噪。若資訊缺失，標示「未揭露」，不要編造，也不要寫「根據搜尋結果」。
Step 1：建立事實清單。
Step 2：依照下方結構撰寫。將資料融入文字中，像是你本來就知道這些事實一樣。

==============================
【推論規則】
- 若需推測，句首必用：「可能 / 傾向 / 暗示 / 推測」，且同一句必須說明依據。
- 範例：推測公司將擴大 B2B 市場，因為近期財報顯示企業端營收成長 30%。

==============================
【輸出結構（嚴格照做）】

# 一、核心摘要
（固定 4 句，總字數 200-240 字。嚴禁出現來源標註）
1) ${symbol} 是誰？
2) 收入模式？
3) 近期動能與壓力？
4) 本報告聚焦的 2-3 個關鍵觀察點。

# 二、基本介紹
## 1. 發展節點與地域分布
- **關鍵節點**：(3 點，每點 1-2 句)
- **地區營收**：(標註主要市場佔比)

## 2. 公司願景與路線圖
(若無明確說明，請標示為推測並由產品演進推論)

## 3. 主要產品與服務
| 服務領域 | 核心產品 | 交付形式 | 主要客群 |
| :--- | :--- | :--- | :--- |

## 4. 商業模式拆解
- **營收組成**：(如：硬體 70%, 服務 30%)
- **誰付錢**：
- **為什麼付錢**：
- **怎麼付錢**：(一次性 / 訂閱 / 抽成)
- **留存與擴張機制**：

## 5. 實質競爭優勢
(僅列出可驗證優勢，並標註類型：無形資產 / 轉換成本 / 成本優勢 / 網路效應)

# 三、產業與競爭
## 1. 市場定位與競爭者
| 競爭者 | 定位 | 優勢 | 劣勢 | 客群重疊度 |
| :--- | :--- | :--- | :--- | :--- |

## 2. 產業趨勢與順風/逆風
(4-6 點，每點 1 句，須具體連結到產業環境)

# 四、風險清單（具體可追蹤）
## 1. 三大核心風險
- **風險 1：** (描述內容，並標註影響之 [會計科目])
- **風險 2：** (描述內容，並標註影響之 [會計科目])
- **風險 3：** (描述內容，並標註影響之 [會計科目])

## 2. 觀察指標 (Monitoring Checklist)
(列出 6-10 個具體指標，須包含財務與營運面)

# 五、下一步研究問題
(5-8 個影響投資判斷的核心問題)
`;
// --- [Pro / 專業版] 建議指令：更硬核、更戰略 ---
const getProPrompt = (symbol, searchContext) => `
你將收到一段「搜尋結果」資料（可能含新聞、公司公告、產品資訊、財報摘要、評論等）。請將其內化後，輸出一份專供【家族辦公室 / 高淨值投資人】使用的【機構級決策備忘錄】。

【輸入資料】
${searchContext}

【角色設定】
你是頂尖對沖基金的首席投資官（CIO）。寫作風格：簡潔、強勢、有框架、有結論、可被投委會直接拿去討論。

【🚫 報告三大禁忌】
1) 不要科普產品；只談其在產業鏈中的「議價權 / 毛利定價權 / 結構性優勢」。
2) 不要模糊結論；必須給出「核心假設」與「勝率/風險報酬」。
3) 不要免責聲明與引用標記；不要寫「根據搜尋結果」。

【允許的推論邊界（更硬核）】
- 可做 Professional Inference，但每一段判斷都要落到「可驗證的觀察點」：價格、渠道、用戶採用、產品節奏、供應鏈議價、競品反應、管理層資本配置。
- 若資料不足，你要用「假設」補上，但必須明確寫成假設，並在後面列出驗證方法。

【格式要求】
- 仍使用 Markdown 標題與表格
- 重點用 **粗體**

# ⚖️ ${symbol} 機構級深度投資評等報告（Decision Memo）

## 一、結論與投資等級（必填）
- **投資等級：**（Overweight / Neutral / Underweight 或 Buy / Hold / Sell 擇一）
- **一句話 Thesis：**（20-35 字，直指市場誤解與價值拐點）
- **勝率推測：**（例如：Base Case 55% / Bull 25% / Bear 20%）
- **關鍵催化劑：**（3-5 點）
- **關鍵風險：**（3-5 點）

## 二、主流誤解 vs 真正變數（Mispricing Map）
| 市場主流敘事 | 真正的關鍵變數 | 你站哪一邊 | 驗證方式 |
| :--- | :--- | :--- | :--- |

## 三、產業生態鏈與議價權量化
| 鏈條位置 | 議價權等級(1-5) | 定價權來源 | 關鍵對手/供應商 | 對抗策略 | 結構性轉向 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 四、護城河量化評級（Economic Moat）
| 構面 | 星等(1-5) | 趨勢 (擴張/縮減) | 形成原因 | 衰退風險 | 監測指標 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 五、核心假設（Investment Assumptions）
(這是 Pro 的靈魂：把不確定性變成可討論的參數)
| 變數 | Base | Bull | Bear | 你為何這樣假設 | 驗證信號 |
| :--- | :---: | :---: | :---: | :--- | :--- |
| 營收 CAGR(3Y) |  |  |  |  |  |
| 毛利率區間 |  |  |  |  |  |
| 營業利益率 |  |  |  |  |  |
| 資本支出強度 |  |  |  |  |  |
| 競爭壓力（價格/補貼） |  |  |  |  |  |

## 六、估值框架與邊際安全（Valuation & MoS）
(不用硬算 DCF 也行，但一定要「框架」：用相對估值 + 歷史區間 + 現金流防禦力)
- **當前估值在週期中的位置：**（高檔/中位/低檔，並說明背後驅動）
- **估值可接受條件：**（什麼情況下你會願意加碼？）
- **邊際安全來源：**（現金流、回購、資產負債表、防禦性收入）
- **下檔保護：**（極端市況下最可能的估值錨點與盈利底線）

## 七、資本配置與治理（Capital Allocation）
- **資本效率判讀：**（分析 ROIC 與營運現金流的匹配度，判斷是否為「價值創造型」成長）
- **研發 vs 回購/股利：**（是否在「用現金買護城河」）
- **併購策略：**（是補齊能力、還是買成長？）
- **槓桿與財務彈性：**（利率/景氣反轉時的壓力測試）
- **管理層風格判讀：**（工程師文化 / 銷售驅動 / 財務紀律等）

## 八、情境演練（Scenario Analysis）
### 1) 📈 Bull Case（上行路徑）
- **觸發器：**
- **成長天花板：**
- **估值/重評邏輯：**
- **最大風險：**

### 2) 📉 Bear Case（下行預警）
- **風險爆點：**
- **盈利/現金流底線：**
- **可能的市場反應：**
- **止損/降風險訊號：**

## 九、交易型觀察清單（12 週內可驗證）
(給投資人「接下來看什麼」—這是付費價值)
- **財務質量：**（重點監測 DSO 應收帳款天數、營運現金流與淨利背離情況）
- **產品/訂單：**
- **價格/毛利：**
- **競品動作：**
- **監管/訴訟：**
- **管理層訊號：**
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