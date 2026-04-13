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
// 注意：目前最新且穩定的是 gemini-3-flash，使用 v1beta 通道
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-3-flash" 
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
Step 0：資料除噪。若資訊缺失，標示「未披露」，不要編造，也不要寫「根據搜尋結果」。
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

## 2. 懂才抱財報閱讀指南(投資人可在財報分析中重點關注以下指標)

請依照「懂才抱財報分析框架」，從以下可用指標中，
挑選 6–10 個對該公司最具分析價值的核心指標。

選擇指標時，需考慮：
- 公司產業特性
- 商業模式
- 成長階段
- 獲利模式

不要逐項解釋所有指標，只需挑選最關鍵的指標進行分析。

每個指標需說明：
1. 為何此指標對該公司特別重要
2. 投資人應關注的變化方向
可選指標如下：

### 損益表 (Income Statement)
關注公司的收入結構、盈利能力與成長動能

可選指標：
- 營收 (Revenue)
- 淨利 / 淨利率 (Net Income / Net Margin)
- 毛利 / 毛利率 (Gross Profit / Gross Margin)
- EPS (Earnings Per Share)

### 資產負債表 (Balance Sheet)
關注公司的財務結構、償債能力與資本結構

可選指標：
- 股東權益 (Shareholders’ Equity)
- 流動比率 (Current Ratio)
- 償債能力 (Debt-related indicators)

### 現金流量表 (Cash Flow Statement)
關注企業的現金創造能力與資本配置

可選指標：
- 營運現金流 (Operating Cash Flow)
- 資本支出 / 營運現金比 (Capex / Operating Cash Flow)
- 營運現金 / 淨利比 (Operating Cash Flow / Net Income)

### 估值與資本回報 (Valuation & Return Metrics)
評估企業資本效率與市場定價

可選指標：
- ROE
- ROA
- PE
- PEG

# 五、關鍵新訊追蹤清單（News Monitoring Tags）
(針對 ${symbol} 建立自動化追蹤維度，建議讀者訂閱以下主題的新聞快訊)

1. **核心業務動態**：(例如：追蹤 [特定產品] 的訂單中標公告或技術更新)
2. **財務風險預警**：(例如：監測 [特定會計科目] 的異常變動或裁員傳聞)
3. **競爭對手威脅**：(例如：監測 [主要對手] 是否推出更低價的同質產品)
4. **宏觀環境影響**：(例如：追蹤 [特定國家/地區] 的 IT 支出預算政策)
5. **管理層與治理**：(例如：監測內部人持股變動或高層異動)
`;
// --- [Pro / 專業版] 建議指令：更硬核、更戰略 ---
const getProPrompt = (symbol, searchContext) => `
你將收到一段「搜尋結果」資料（可能含新聞、公司公告、產品資訊、財報摘要、法說會重點、產業評論等）。請將其內化後，輸出一份專供【高資產使用者 / 深度研究型投資人】閱讀的【深度獵金研究備忘錄】。

【輸入資料】
${searchContext}

【角色設定】
你是頂尖機構研究團隊的首席研究員。你的任務不是提供買賣建議，而是用最高密度的方式，整理一家公司的商業本質、關鍵變數、護城河變化、資本配置邏輯與後續驗證重點。
寫作風格：簡潔、直接、有框架、有洞察，內容要能被專業使用者直接拿去做後續研究。

【核心原則】
1) 不提供買賣建議、投資評等、目標價、加碼建議、止損指令。
2) 不做空泛科普；重點放在商業模式、產業位置、議價權、競爭結構、資本效率與市場誤解。
3) 可以做專業推論，但每一段判斷都必須落到「可驗證觀察點」。
4) 若資料不足，可提出假設，但必須明確標示為「假設」，並附上驗證方式。
5) 不要免責聲明，不要寫「根據搜尋結果」。
6) 語氣要有洞察，但避免使用過度武斷或投顧式語句。

【允許的深度】
- 可判讀公司的優勢是否來自產品力、渠道力、品牌力、成本力、平台效應、供應鏈地位或管理層執行力
- 可分析市場目前可能忽略的變數、過度關注的風險、或尚未充分反映的商業變化
- 可用「研究優先級」「值得持續追蹤程度」「核心爭點是否擴大」這類研究語言
- 不可使用「買入 / 賣出 / 加碼 / 減碼 / 目標價 / 勝率 / 報酬率 / 止損」等交易指令或投資建議語言

【格式要求】
- 使用 Markdown 標題與表格
- 重點用 **粗體**
- 以繁體中文輸出
- 內容要像高品質研究備忘錄，而非行銷文章

# 🔍 ${symbol} 深度獵金研究備忘錄

## 一、研究摘要
- **一句話核心判讀：**（20-35 字，直接點出這家公司目前最值得研究的地方）
- **市場關注程度：**（高 / 中 / 低）
- **目前最重要的研究主題：**（3-5 點）
- **市場最容易看錯的地方：**（2-4 點）

## 二、公司現在真正靠什麼在賺錢
請不要泛談產品，而要直接說明公司目前的價值來源與商業引擎。

| 構面 | 關鍵內容 | 對營運的重要性 | 可驗證觀察點 |
| :--- | :--- | :--- | :--- |
| 核心收入引擎 |  | 高 / 中 / 低 |  |
| 關鍵產品 / 服務 |  | 高 / 中 / 低 |  |
| 客戶價值來源 |  | 高 / 中 / 低 |  |
| 商業模式韌性 |  | 高 / 中 / 低 |  |

## 三、產業位置與競爭結構
請聚焦在公司在產業鏈中所處的位置、議價能力來源、與競爭對手相比的優劣勢，不要做教科書式產業介紹。

| 分析面向 | 判讀 | 為什麼重要 | 後續要看什麼 |
| :--- | :--- | :--- | :--- |
| 產業鏈位置 |  |  |  |
| 議價能力來源 |  |  |  |
| 競爭優勢 |  |  |  |
| 競爭壓力 |  |  |  |
| 產業結構變化 |  |  |  |

## 四、護城河與結構性優勢
| 構面 | 強度(1-5) | 目前方向 | 形成原因 | 可能弱化因素 | 監測指標 |
| :--- | :---: | :--- | :--- | :--- | :--- |
| 品牌 / 用戶心智 |  | 擴張 / 穩定 / 縮減 |  |  |  |
| 成本優勢 |  | 擴張 / 穩定 / 縮減 |  |  |  |
| 網路效應 / 平台效應 |  | 擴張 / 穩定 / 縮減 |  |  |  |
| 轉換成本 |  | 擴張 / 穩定 / 縮減 |  |  |  |
| 執行力 / 管理層能力 |  | 擴張 / 穩定 / 縮減 |  |  |  |

## 五、成長引擎與限制因子
這一段要回答：未來幾年，公司成長最可能從哪裡來，又最可能卡在哪裡。

| 項目 | 內容 | 對未來的重要性 | 驗證方式 |
| :--- | :--- | :--- | :--- |
| 主要成長引擎 |  | 高 / 中 / 低 |  |
| 次要成長來源 |  | 高 / 中 / 低 |  |
| 最大限制因子 |  | 高 / 中 / 低 |  |
| 最容易被忽略的變數 |  | 高 / 中 / 低 |  |

## 六、資本配置與經營品質
請重點分析公司是否在用資本創造長期價值，而不是只追求表面成長。

- **資本配置風格：**（偏擴張 / 偏保守 / 偏股東回饋 / 偏併購整合）
- **資本效率判讀：**（ROIC、現金流、再投資方向是否一致）
- **研發 / 行銷 / 資本支出是否合理：**
- **併購策略的作用：**（補能力、補市場、補成長，還是增加複雜度）
- **管理層風格：**（產品驅動 / 財務紀律 / 銷售導向 / 工程文化等）

## 七、市場目前在定價什麼
這一段不是要給估值建議，而是要說明市場現在更重視哪些變數、忽略哪些變數。

| 市場目前聚焦點 | 可能被低估的因素 | 可能被高估的因素 | 後續驗證點 |
| :--- | :--- | :--- | :--- |

## 八、核心研究假設
請用研究框架而不是投資建議來寫，把不確定性整理成可討論的假設。

| 假設主題 | 目前基礎判讀 | 支持理由 | 反證訊號 | 後續驗證方式 |
| :--- | :--- | :--- | :--- | :--- |
| 收入成長持續性 |  |  |  |  |
| 毛利率結構 |  |  |  |  |
| 獲客 / 留存效率 |  |  |  |  |
| 成本控制能力 |  |  |  |  |
| 護城河穩定度 |  |  |  |  |

## 九、接下來最值得追蹤的重點
請給出真正有研究價值的追蹤清單，而不是空泛的「留意財報」。

- **產品 / 服務：**
- **價格 / 毛利：**
- **需求 / 訂單：**
- **現金流 / 資本支出：**
- **管理層訊號：**
- **競品 / 產業鏈變化：**

## 十、總結：這家公司目前最值得深挖的原因
請用一小段話總結：
1. 這家公司目前最值得研究的核心爭點是什麼
2. 這個爭點為什麼重要
3. 下一步最有效率的研究方向是什麼
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
    const modelName = isPro ? "gemini-3-flash" : "gemini-3-flash"; 
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
      plan: userPlan,
      searchContext: searchContext
    });

  } catch (err) {
    console.error("後端錯誤:", err);
    res.status(500).json({ error: err.message || '伺服器忙碌中' });
  }
});
// ===== 新增：AI 深度追問 Endpoint =====
app.post('/api/chat-with-report', async (req, res) => {
  const { symbol, searchContext, userQuery } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: '未登入' });

  try {
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) throw new Error('身分驗證失敗');

    const { data: profile } = await supabase.from('profiles').select('plan').eq('id', user.id).single();
    const userPlan = (profile?.plan || 'free').toLowerCase();
    
    const modelName = "gemini-3-flash"; 

    // --- (保留原本的問答限流攔截器邏輯) ---
    if (userPlan !== 'pro') {
      const startOfWeek = new Date();
      startOfWeek.setHours(0, 0, 0, 0);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

      const { count: chatCount, error: countError } = await supabase
        .from("usage_logs")
        .select("*", { count: 'exact', head: true })
        .eq("user_id", user.id)
        .eq("action", "chat_query")
        .gte("created_at", startOfWeek.toISOString());

      if (countError) throw new Error("無法讀取對話紀錄");

      const chatLimit = userPlan === 'plus' ? 20 : 5; 
      if (chatCount >= chatLimit) {
        return res.status(403).json({ 
          error: `已達本週對話上限。您的 ${userPlan} 方案配額為每週 ${chatLimit} 次，請升級 Pro 方案以解鎖無限對話。` 
        });
      }
    }

    const chatPrompt = `
    你是一位專業的資深產業研究員，擅長從碎片化的資訊中萃取出具投資價值的商業洞察。投資人剛看完報告，現在要針對細節進行追問。

    【背景資料】：
    ${searchContext}

    【指令】：
    1. **直擊核心**：針對投資人的追問「${userQuery}」進行深度解析。
    2. **資訊整合**：請將【背景資料】中的數據與事實自然融入邏輯，內化後以「目前市場觀察顯示...」或「從現有數據看來...」的方式呈現。
    3. **字數限制**：總字數嚴格控制在 **300-500 字** 之間，確保一分鐘內可掌握核心點。
    4. **刪除廢話**：嚴禁開場白（如：針對您的問題...）與機械化措辭（如：資料 1 顯示...）。
    5. **知識互補**：若背景資料不足，請以「根據產業通用資訊補充：」為開頭，加入對競爭格局、技術趨勢或財務邏輯的深度見解。
    6. **專業口吻**：語氣冷靜、數據導向且具批判性思維，嚴禁提供買賣建議。
    7. **禁止標記** : 禁止出現如「(資料 1)」、「根據資料 5」、「(來源 3)」或任何括號數字。

    【回覆架構（嚴格執行）】：
    ### 核心回答
    (用 1-2 句最精煉的語言直接回答問題核心)

    ### 深度解析
    - **[關鍵維度 A]**：(融入事實與數據的深入分析)
    - **[關鍵維度 B]**：(分析競爭優勢或潛在變數)
    - **[關鍵維度 C]**：(分析技術路徑或市場地位)

    ### 關鍵觀察指標
    - (列出 2-3 個投資人應持續追蹤的具體後續變數)
    `;
    // ==========================================
    // ★ 修改開始：設定 HTTP Header 支援串流
    // ==========================================
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // 使用 generateContentStream 啟動串流
    const chatModel = genAI.getGenerativeModel({ model: modelName });
    const result = await chatModel.generateContentStream(chatPrompt);

    // 逐塊讀取 AI 生成的文字並發送給前端
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      res.write(chunkText); 
    }

    // 成功完成後紀錄行為
    await supabase.from('usage_logs').insert({ user_id: user.id, action: 'chat_query' });
    
    // 正式結束 HTTP 連線
    res.end();

  } catch (err) {
    console.error("對話錯誤:", err);
    // 如果 Header 尚未發送，回傳 JSON 錯誤；若已開始串流，則直接結束
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || '對話發生錯誤' });
    } else {
      res.end();
    }
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