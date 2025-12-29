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

// --- 主要 API ---
app.post('/api/analyze-stock', async (req, res) => {
  const { symbol } = req.body;
  const authHeader = req.headers.authorization;

  // 1. 檢查有沒有帶 Token
  if (!authHeader) {
    return res.status(401).json({ error: '未登入' });
  }
  
  try {
    // 2. 驗證使用者身分
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      throw new Error('身分驗證失敗');
    }

    // 3. 檢查方案與額度
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', user.id)
      .single();
    
    const userPlan = profile?.plan || 'free';
    const limit = PLAN_LIMIT[userPlan];

    // 檢查本週用量
    if (limit !== Infinity) {
      const startOfWeek = new Date();
      startOfWeek.setHours(0, 0, 0, 0);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // 週日為起始

      const { count } = await supabase
        .from('usage_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('action', 'company_intro')
        .gte('created_at', startOfWeek.toISOString());

      if (count >= limit) {
        return res.status(403).json({ error: `已達本週使用上限 (${count}/${limit})，請升級方案。` });
      }
    }

    // ==========================================
    // ★ 核心邏輯：還原 n8n 的深度分析
    // ==========================================
    console.log(`[${new Date().toISOString()}] 用戶 ${user.email} 查詢: ${symbol} (n8n 還原模式)`);

    // A. 搜尋階段：為了支撐 n8n 那樣的長文，我們需要更豐富的資料
    // 我們一次搜尋 15 筆，包含商業模式、風險、競爭對手
    const searchQuery = `${symbol} stock business model revenue competitive advantage risks competitors analysis financial report`;
    
    // 設定 num=15 以獲取更多資料
    const serpApiUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${process.env.SERPAPI_KEY}&num=15&hl=zh-tw&gl=tw`;
    
    const searchResponse = await axios.get(serpApiUrl);
    const searchResults = searchResponse.data.organic_results || [];

    // B. 資料整理：把搜尋結果轉成 AI 看得懂的文字
    const searchContext = searchResults.map((item, index) => {
      const date = item.date || "近期";
      return `[資料 ${index + 1}] 標題: ${item.title}\n來源: ${item.source} (${date})\n摘要: ${item.snippet}\n連結: ${item.link}`;
    }).join("\n\n");

    // C. 設定 Prompt：完全移植 n8n 的詳細指令 (合併上半部與下半部)
    const prompt = `
      請閱讀以下的搜尋結果資料：
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
      (分析該公司的領導風格，例如「工程師文化」或「行銷導向」。)
    `;

    // D. 呼叫 Gemini
    const aiResult = await model.generateContent(prompt);
    const responseText = aiResult.response.text();

    // 4. 成功後，寫入使用紀錄
    await supabase.from('usage_logs').insert({
      user_id: user.id,
      action: 'company_intro'
    });

    // 5. 回傳結果
    res.json({ text: responseText });

  } catch (err) {
    console.error("後端錯誤:", err);
    // 區分錯誤類型回傳
    if (err.response && err.response.status === 401) {
        res.status(401).json({ error: '權限不足' });
    } else {
        res.status(500).json({ error: err.message || '伺服器忙碌中，請稍後再試' });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`後端伺服器啟動中： http://localhost:${PORT}`);
});