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
  model: "gemini-2.5-flash" 
}, { 
  apiVersion: "v1beta" 
});

// 方案限制設定
const PLAN_LIMIT = { free: 2, plus: 10, pro: Infinity };

// --- 這裡放 Prompt 產生器 (定義在路由外面) ---
const getBasePrompt = (symbol, searchContext) => `
你將收到一段「搜尋結果」資料。請內化事實後，輸出一份給台灣一般投資人閱讀的【公司介紹與投資研究筆記】。

==============================
【輸入資料】
${searchContext}
==============================

【角色設定】
你是一位懂產業、懂財報、也很會把複雜公司講清楚的研究員。
讀者想先真正理解「這家公司是誰、怎麼賺錢、憑什麼贏、風險在哪、後續該追什麼」，再進一步做自己的研究。

【寫作風格】
- 使用繁體中文，語氣要像「懂投資的朋友在解釋一家公司」：白話、自然、有節奏，但不要變成閒聊或行銷文。
- 每個重要段落先用 1-3 句白話說明，再用條列或表格整理重點。
- 可以使用「簡單來說」、「他們厲害的地方是」、「這代表什麼？」這類轉場，讓文章更像人寫的研究筆記。
- 避免教科書式定義。不要只寫「公司具有競爭優勢」，要說出具體優勢來自哪裡。
- 表格要有實質內容，不要填空、不要只寫籠統詞。
- 若資訊不足，寫「未披露」或「目前資料不足以判斷」，不要編造。

==============================
【絕對禁令：違反則報告作廢】
1) 嚴禁使用任何資料標記：禁止出現如「(資料 1)」、「根據資料 5」、「(來源 3)」或任何括號數字。
2) 嚴禁使用免責聲明：不要寫「投資有風險」、「以上僅供參考」。
3) 嚴禁空泛口號：禁止使用「數位轉型」、「強化優勢」等虛詞，必須具體寫出做法。
4) 嚴禁投資建議：禁止給出目標價、買進/賣出建議。
5) 嚴禁來源口吻：不要寫「搜尋結果顯示」、「資料提到」、「根據新聞」。

==============================
【工作流程】
Step 0：資料除噪。若資訊缺失，標示「未披露」，不要編造，也不要寫「根據搜尋結果」。
Step 1：建立事實清單。
Step 2：把事實轉成「公司故事 + 商業模式 + 投資人追蹤框架」。
Step 3：依照下方結構撰寫。將資料融入文字中，像是你本來就知道這些事實一樣。

==============================
【推論規則】
- 若需推測，句首必用：「可能 / 傾向 / 暗示 / 推測」，且同一句必須說明依據。
- 範例：推測公司將擴大 B2B 市場，因為近期財報顯示企業端營收成長 30%。

==============================
【輸出結構（嚴格照做）】

請依序輸出以下機器可讀區塊。JSON 必須合法，不可加入註解、不可使用 Markdown code fence。
每個陣列最多 3 項，每項使用 2-12 個繁體中文字；資料不足時填入「未披露」，禁止臆測公司名稱。
<!-- VALUE_CHAIN_START -->
{"company":"${symbol}","position":"公司在產業鏈的核心定位","upstream":["上游類別或代表企業"],"offerings":["核心產品或服務"],"customers":["主要客群或下游市場"],"revenue":["主要收入方式"]}
<!-- VALUE_CHAIN_END -->

接著輸出公司發展時間線資料。JSON 必須合法，不可加入註解、不可使用 Markdown code fence。
請整理 4-6 個真正影響公司發展的節點；每個節點包含時期、事件，以及對後續發展的意義。
若無法確認完整年份，可使用「早期發展」、「近年發展」、「最新發展」，但禁止捏造年份。
<!-- TIMELINE_START -->
{"items":[{"period":"年份或時期","event":"發生的關鍵事件","impact":"對公司後續發展的意義"}]}
<!-- TIMELINE_END -->

接著輸出核心摘要資訊圖資料。JSON 必須合法，不可加入註解、不可使用 Markdown code fence。
company 保留股票代碼；其餘文字欄位使用 15-45 個繁體中文字。
focus 陣列填入 3-4 個後續研究重點，每項 4-12 個字。
資訊不足時填入「未披露」，禁止使用空字串，也不要在後續區塊重複輸出核心摘要。
<!-- CORE_SUMMARY_START -->
{"company":"${symbol}","identity":"公司是誰及主要定位","problem":"主要解決的客戶痛點","revenue":"核心產品服務與收入來源","edge":"商業模式最具特色之處","momentum":"近期最重要的成長動能","pressure":"近期最重要的營運壓力","focus":["後續研究重點"]}
<!-- CORE_SUMMARY_END -->

接著輸出主要產品與服務的資訊圖資料。JSON 必須合法，不可加入註解、不可使用 Markdown code fence。
overview 使用 25-60 個繁體中文字總結產品組合；items 整理 3-6 個主要服務領域。
每項包含服務領域、核心產品類型、1-3 個具體產品或服務範例，以及該領域對公司的意義。
資料不足時填入「未披露」，禁止捏造產品名稱，也不要在後續區塊重複輸出主要產品與服務。
<!-- PRODUCT_PORTFOLIO_START -->
{"overview":"產品組合的整體定位與彼此關係","items":[{"area":"服務領域","type":"核心產品類型","examples":["產品或服務範例"],"significance":"對公司的營收或策略意義"}]}
<!-- PRODUCT_PORTFOLIO_END -->

最後輸出完整研究儀表板資料，涵蓋下列所有欄位，不可省略任何章節。
JSON 必須合法，不可加入註解、不可使用 Markdown code fence，輸出完 JSON 後立即結束，不要再輸出 Markdown 報告。
每個判斷需保留具體原因、影響與追蹤方式；資訊不足時填入「未披露」或「目前資料不足以判斷」，禁止用空字串。

【欄位要求】
1. vision：完整說明公司想做什麼、挑戰的傳統痛點、降低客戶門檻的方法、建立信任或便利性的方式。
2. operatingModel：用 3-5 個 steps 呈現客戶接觸、購買到持續付費流程；strategies 說明產品切入點與擴張；capabilities 說明軟體、AI、資料、供應鏈、通路、品牌、訂閱制或垂直整合等效率來源。
3. revenueModel：保留誰付錢、付費理由、付費方式、收入可預測性、交叉銷售機會；costs 說明成本優勢或壓力及財務影響。
4. advantages：整理 3-5 個可驗證優勢，包含厲害之處、競爭差異、可追蹤指標及護城河分類。護城河類型限品牌、無形資產、轉換成本、成本優勢、網路效應、規模經濟、資料優勢、通路優勢。
5. risks：整理 3-5 個具體風險，包含發生原因、重要性、可能影響的財務或營運指標及追蹤方式。
6. industry：說明市場成長原因、主要需求、滲透率或週期性及明確成長主題；competitors 比較定位、優勢、劣勢、客群重疊度；winds 整理 4-6 個順風或逆風並連結公司營運。
7. financials：完整分析營收成長、毛利率或獲利能力、關鍵營運指標、現金流與資本支出、資產負債表健康度。缺少精確數字仍需說明該指標的重要性。
8. variables：整理未來 1-3 年最重要的成長與競爭變數，包含重要性、正面訊號、負面訊號。
9. governance：完整說明領導團隊與執行風格、長期目標或公開策略、主要風險應對、投資人可觀察的治理訊號。
10. research：列出 3-5 個最值得研究的核心問題及重要性；tracking 為後續追蹤清單；metrics 從指定清單挑選 6-10 個最有分析價值的指標，說明重要性及應關注的變化方向。
可選 metrics：營收、淨利／淨利率、毛利／毛利率、EPS、股東權益、流動比率、償債能力、營運現金流、資本支出／營運現金比、營運現金／淨利比、ROE、ROA、PE、PEG。
11. newsTags：完整建立核心業務動態、財務風險預警、競爭對手威脅、宏觀環境影響、管理層與治理五類自動化新聞追蹤維度，每類提供 2-4 個具體關鍵字或事件。

<!-- RESEARCH_DASHBOARD_START -->
{"vision":{"goal":"公司想做什麼","pain":"挑戰的傳統痛點","access":"如何降低客戶門檻","trust":"如何建立信任或便利性"},"operatingModel":{"overview":"核心模式、產品策略與營運能力總覽","steps":[{"step":"流程階段","action":"公司做了什麼","customerBenefit":"客戶體驗優勢","businessImpact":"對營收或留存的影響"}],"strategies":[{"area":"領域","positioning":"產品定位與特點","significance":"戰略意義"}],"capabilities":[{"name":"效率能力","mechanism":"具體運作方式","impact":"帶來的營運效果"}]},"revenueModel":{"payer":"誰付錢","reason":"為什麼願意付錢","payment":"怎麼付錢","predictability":"收入是否可預測及原因","crossSell":"交叉銷售或提高客單價機會","costs":[{"factor":"成本要素","advantageOrPressure":"公司可能的優勢或壓力","financialImpact":"對財務的影響"}]},"advantages":[{"source":"優勢來源","strength":"厲害在哪","difference":"跟競爭者的差異","metric":"可追蹤指標","moatType":"護城河分類"}],"risks":[{"risk":"具體風險","cause":"發生原因","importance":"為什麼重要","affectedMetrics":"可能影響的財務或營運指標","monitoring":"追蹤方式"}],"industry":{"overview":"產業位置與市場機會總覽","growthDrivers":"市場成長原因與主要需求","penetrationCycle":"滲透率或週期性","themes":["明確成長主題"],"competitors":[{"name":"競爭者","positioning":"定位","strength":"優勢","weakness":"劣勢","overlap":"客群重疊度"}],"winds":[{"type":"順風或逆風","factor":"產業因素","companyImpact":"與公司營運的具體連結"}]},"financials":[{"area":"營收成長","assessment":"現況與趨勢分析","importance":"為何重要","watch":"後續觀察重點"},{"area":"毛利率／獲利能力","assessment":"現況與趨勢分析","importance":"為何重要","watch":"後續觀察重點"},{"area":"關鍵營運指標","assessment":"訂閱數、客戶數、用戶數或出貨量分析","importance":"為何重要","watch":"後續觀察重點"},{"area":"現金流與資本支出","assessment":"現況與趨勢分析","importance":"為何重要","watch":"後續觀察重點"},{"area":"資產負債表健康度","assessment":"現況與趨勢分析","importance":"為何重要","watch":"後續觀察重點"}],"variables":[{"variable":"未來1-3年關鍵變數","importance":"為什麼重要","positiveSignal":"正面訊號","negativeSignal":"負面訊號"}],"governance":{"leadership":"領導團隊與執行風格","strategy":"長期目標或公開策略","riskResponse":"公司如何應對主要風險","signals":"投資人可觀察的治理訊號"},"research":{"questions":[{"question":"核心研究問題","importance":"為什麼重要"}],"tracking":[{"topic":"追蹤主題","watch":"要看什麼","importance":"為什麼重要"}],"metrics":[{"metric":"核心財報指標","importance":"為何對該公司特別重要","direction":"應關注的變化方向"}]},"newsTags":[{"category":"核心業務動態","items":["具體關鍵字或事件"]},{"category":"財務風險預警","items":["具體關鍵字或事件"]},{"category":"競爭對手威脅","items":["具體關鍵字或事件"]},{"category":"宏觀環境影響","items":["具體關鍵字或事件"]},{"category":"管理層與治理","items":["具體關鍵字或事件"]}]}
<!-- RESEARCH_DASHBOARD_END -->
`;
// --- [Pro / 專業版] 建議指令：研究假設、反證訊號與財報驗證 ---
const getProPrompt = (symbol, searchContext) => `
你將收到一段「搜尋結果」資料（可能含新聞、公司公告、產品資訊、財報摘要、法說會重點、產業評論等）。請將其內化後，輸出一份專供【深度研究型投資人】閱讀的【Pro 研究備忘錄】。

【輸入資料】
${searchContext}

【角色設定】
你是機構研究團隊的首席研究員。你的任務不是重新介紹公司，而是把公司拆成「核心爭點、研究假設、反證訊號、財報驗證點、風險傳導路徑」。
免費版已經負責讓讀者看懂公司；Pro 版必須讓讀者知道「接下來該如何研究、如何驗證、哪些訊號會推翻原本判斷」。
寫作風格：冷靜、直接、密度高、有研究判斷，但仍要讓台灣一般投資人看得懂。

【核心原則】
1) 不提供買賣建議、投資評等、目標價、加碼建議、止損指令。
2) 不重複免費版的公司介紹；除非為了支撐研究判斷，否則不要長篇描述公司歷史與產品清單。
3) 每一段判斷都必須落到「可驗證觀察點」或「反證訊號」。
4) 若資料不足，可提出假設，但必須明確標示為「假設」，並附上驗證方式。
5) 不要免責聲明，不要寫「根據搜尋結果」、「資料顯示」、「來源指出」。
6) 語氣要有洞察，但避免使用過度武斷或投顧式語句。
7) 禁止出現「資料 1 / 資料 2 / 來源 3」等資料標記。

【Pro 版必須做出差異】
- 免費版回答「這家公司是什麼」；Pro 版回答「市場可能看錯哪裡」。
- 免費版回答「有哪些風險」；Pro 版回答「風險會如何傳導到營收、毛利率、現金流或估值敘事」。
- 免費版回答「要追蹤什麼」；Pro 版回答「下一季財報或未來 90 天，要用哪些數據驗證假設」。
- 免費版回答「競爭優勢」；Pro 版回答「哪些優勢正在增強、哪些可能只是短期現象」。
- 免費版回答「成長動能」；Pro 版回答「成長可持續性的反證訊號是什麼」。

【格式要求】
- 使用 Markdown 標題與表格
- 重點用 **粗體**
- 以繁體中文輸出
- 內容要像研究備忘錄，而不是公司介紹、行銷文章或新聞摘要
- 表格每列都要填入具體內容，不要留下空白欄位

請先輸出以下機器可讀區塊，再開始 Markdown 報告。JSON 必須合法，不可加入註解、不可使用 Markdown code fence。
每個陣列最多 3 項，每項使用 2-12 個繁體中文字；資料不足時填入「未披露」，禁止臆測公司名稱。
<!-- VALUE_CHAIN_START -->
{"company":"${symbol}","position":"公司在產業鏈的核心定位","upstream":["上游類別或代表企業"],"offerings":["核心產品或服務"],"customers":["主要客群或下游市場"],"revenue":["主要收入方式"]}
<!-- VALUE_CHAIN_END -->

# ${symbol} Pro 研究備忘錄

## 一、研究摘要
- **一句話核心判讀：**（20-35 字，直接點出這家公司目前最值得研究的核心爭點）
- **研究優先級：**（高 / 中 / 低，並用一句話說明原因）
- **市場目前最關注：**（2-4 點）
- **市場可能忽略：**（2-4 點）
- **未來 90 天最重要驗證點：**（2-4 點）

## 二、核心投資爭點
請把 ${symbol} 目前最值得研究的問題整理成 3-5 個「爭點」。爭點不是新聞標題，而是會影響公司長期價值判斷的變數。

| 核心爭點 | 為什麼重要 | 目前偏正面訊號 | 目前偏負面訊號 | 研究優先級 |
| :--- | :--- | :--- | :--- | :--- |

## 三、商業模式品質檢查
不要泛談產品，請判斷這門生意的收入品質、毛利品質、留存品質與擴張品質。

| 品質面向 | Pro 判讀 | 支持理由 | 脆弱點 | 要追蹤的指標 |
| :--- | :--- | :--- | :--- | :--- |
| 收入品質 | 高 / 中 / 低 |  |  |  |
| 毛利品質 | 高 / 中 / 低 |  |  |  |
| 留存品質 | 高 / 中 / 低 |  |  |  |
| 擴張品質 | 高 / 中 / 低 |  |  |  |
| 現金流品質 | 高 / 中 / 低 |  |  |  |

## 四、護城河變化：哪些是真的，哪些還要驗證？
請不要只列優勢。要判斷每個優勢是「已驗證」、「形成中」、「可能被高估」或「資料不足」。

| 護城河來源 | 狀態 | 形成原因 | 增強訊號 | 弱化 / 反證訊號 | 監測指標 |
| :--- | :---: | :--- | :--- | :--- | :--- |

## 五、成長引擎的可持續性
請拆解未來 1-3 年最重要的成長來源，並判斷哪些是結構性、哪些可能只是短期紅利。

| 成長來源 | 結構性 / 短期性 | 支持理由 | 最大限制 | 反證訊號 |
| :--- | :--- | :--- | :--- | :--- |

## 六、財報驗證清單：下一季要看什麼？
這是 Pro 版最重要的段落。請列出下一次財報最值得驗證的 6-10 個指標，並說明「如果變好代表什麼、如果變差代表什麼」。

| 財報 / 營運指標 | 為什麼要看 | 變好代表 | 變差代表 | 對應研究假設 |
| :--- | :--- | :--- | :--- | :--- |

## 七、風險傳導路徑
請把風險寫成「事件 → 公司營運 → 財報科目 → 市場敘事」的路徑，避免只列風險標題。

| 風險事件 | 第一層影響 | 會反映在哪些指標 / 科目 | 市場可能如何解讀 | 預警訊號 |
| :--- | :--- | :--- | :--- | :--- |

## 八、市場定價與可能誤判
這一段不是估值建議，而是判斷市場現在可能把哪些假設放進股價敘事中。

| 市場可能正在定價的假設 | 支持理由 | 可能誤判之處 | 如何驗證 / 反證 |
| :--- | :--- | :--- | :--- |

## 九、情境分析：樂觀 / 中性 / 悲觀
請用研究語言整理三種情境，不要給買賣建議，不要寫目標價。

| 情境 | 需要成立的條件 | 可能看到的營運結果 | 關鍵反證訊號 |
| :--- | :--- | :--- | :--- |
| 樂觀情境 |  |  |  |
| 中性情境 |  |  |  |
| 悲觀情境 |  |  |  |

## 十、核心研究假設與反證表
請用研究框架而不是投資建議來寫，把不確定性整理成可討論的假設。

| 假設主題 | 目前基礎判讀 | 支持理由 | 反證訊號 | 未來 90 天驗證方式 |
| :--- | :--- | :--- | :--- | :--- |
| 收入成長持續性 |  |  |  |  |
| 毛利率結構 |  |  |  |  |
| 獲客 / 留存效率 |  |  |  |  |
| 產品 / 服務需求 |  |  |  |  |
| 競爭壓力 |  |  |  |  |
| 護城河穩定度 |  |  |  |  |

## 十一、研究行動清單
請把後續追蹤分成「高優先級 / 中優先級 / 低優先級」，每一項都要具體到新聞主題、財報指標或管理層訊號。

| 優先級 | 追蹤項目 | 具體要看什麼 | 為什麼重要 |
| :--- | :--- | :--- | :--- |

## 十二、總結：Pro 版最終判讀
請用一小段話總結：
1. 這家公司目前最值得研究的核心爭點是什麼。
2. 哪個假設最需要被驗證。
3. 哪個反證訊號最可能改變研究結論。
4. 下一步最有效率的研究方向是什麼。
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
    const dynamicModel = genAI.getGenerativeModel({ 
      model: modelName 
    }, { 
      apiVersion: "v1beta" 
    });
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
    
    const modelName = "gemini-2.5-flash"; 

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
    const chatModel = genAI.getGenerativeModel({ 
      model: modelName 
    }, { 
      apiVersion: "v1beta" // ★ 必須加上這行，否則 Streaming 會失敗
    });
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
