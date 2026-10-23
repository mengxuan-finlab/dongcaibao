function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function detectMarket(symbol) {
  const value = normalizeSymbol(symbol);
  if (/^\d{4}(\.TW|\.TWO)?$/.test(value)) return 'TW';
  return 'US';
}

function buildSearchQueries(symbol, market) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (market === 'TW') {
    return [
      `${normalizedSymbol} 台股 公司介紹 主要產品 商業模式`,
      `${normalizedSymbol} 產業鏈 客戶 供應商 競爭對手`,
      `${normalizedSymbol} 法說會 年報 公司歷史 經營團隊 策略 風險`
    ];
  }

  const queries = [
    `${normalizedSymbol} stock business model competitive advantage risks analysis`,
    `${normalizedSymbol} investor presentation business segments competitors risks`,
    `${normalizedSymbol} annual report company history management strategy risks`
  ];

  return queries;
}

const getBasePrompt = (symbol, searchContext, market = 'US') => `
請用以下資料整理一份繁體中文「公司研究短報」，只有七節：Business、Segments、History & Footprint、Management & Strategy、Industry & Competition、Thesis、Risks。
【股票代碼】${symbol}
【市場別】${market}
【輸入資料】
${searchContext}

【寫作要求】
- 全文說明以約 450-650 個繁體中文字為目標（不含欄位名），每個說明欄位只用一句、約 15-35 字；名稱、產品例子保持短詞。避免重複，不要長篇背景。
- 只使用可確認的事實；資訊不足明確填「未披露」或「目前資料不足以判斷」，不要捏造數據、產品或事件。
- 推論需標示「可能」並簡述依據；不要給目標價或買賣建議。
- 不要額外產生財務分析、估值、預測、長時間軸、競爭比較表、研究問題或新聞標籤。
- 產品及地區營收數據另由 FMP 圖表提供，不要估算營收占比或重複輸出數字。

【欄位要求】
- company（Business）：symbol 保留股票代碼；overview 說明做什麼，revenue 說明如何賺錢，customers 說明誰付錢。
- products（Segments）：以 1-2 個主要業務分部為目標，examples 各列 1-2 個短例子，significance 一句說明其角色。
- history（History & Footprint）：milestones 用一句整理最多兩個有來源的發展轉折；footprint 一句說明主要市場或營運布局。沒有可靠年份就不寫年份。
- management（Management & Strategy）：team 一句說明經營團隊與職務，只使用來源可確認的人名；strategy 一句說明目前的策略方向。無法確認現任者請註明資料不足。
- industry（Industry & Competition）：competition 一句說明產業與主要競爭者；advantage 一句說明差異及限制，不可把公司宣傳直接當作已證實優勢。
- thesis（Thesis）：opportunity 一句提出附依據且標示為推論的核心研究論點；condition 一句寫出論點成立的條件或可推翻的訊號，不是推薦買進。
- risks（Risks）：以 2 個主要風險為目標，risk 為短標題、reason 一句具體影響、watch 一個追蹤訊號。
- 所有欄位都要填寫，陣列不可空白；資料不足可明確註明，不要為了湊數編造。

【輸出結構】
<!-- COMPACT_REPORT_START -->
{"company":{"symbol":"${symbol}","overview":"公司做什麼","revenue":"主要收入來源與收費方式","customers":"主要客戶或付費者"},"products":[{"name":"主要業務分部","examples":["具體產品或服務"],"significance":"此分部的角色"}],"history":{"milestones":"主要發展轉折","footprint":"主要市場或營運布局"},"management":{"team":"經營團隊與職務","strategy":"目前策略方向"},"industry":{"competition":"產業與主要競爭者","advantage":"差異與競爭限制"},"thesis":{"opportunity":"有依據的研究推論","condition":"成立條件或反證訊號"},"risks":[{"risk":"具體風險","reason":"對公司的影響","watch":"追蹤訊號"}]}
<!-- COMPACT_REPORT_END -->
`;

module.exports = { getBasePrompt, normalizeSymbol, detectMarket, buildSearchQueries };
