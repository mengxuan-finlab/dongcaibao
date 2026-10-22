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
      `${normalizedSymbol} 法說會 年報 產業展望 風險`
    ];
  }

  const queries = [
    `${normalizedSymbol} stock business model competitive advantage risks analysis`,
    `${normalizedSymbol} investor presentation business segments competitors risks`,
    `${normalizedSymbol} annual report business overview industry outlook`
  ];

  return queries;
}

const getBasePrompt = (symbol, searchContext, market = 'US') => `
請用以下資料整理一份繁體中文「公司研究精簡版」，只回答四個重點：公司與收入、主要產品、成長與風險、財報觀察。
【股票代碼】${symbol}
【市場別】${market}
【輸入資料】
${searchContext}

【寫作要求】
- 白話、具體；每個說明用 1-2 句，約 25-60 個繁體中文字，避免重複。
- 只使用可確認的事實；資訊不足明確填「未披露」或「目前資料不足以判斷」，不要捏造數據、產品或事件。
- 推論需標示「可能」並簡述依據；不要給目標價或買賣建議。
- 不要產生時間軸、獨立價值鏈、治理、競爭比較表、研究問題清單、新聞標籤或額外報告。
- 台股財報觀察可選月營收、毛利率、庫存等；美股可選營收、自由現金流、客戶數等，不必分析整套財報。

【欄位要求】
- company：symbol 保留股票代碼；overview 說明做什麼，revenue 說明如何賺錢，customers 說明誰付錢。
- products：列 1-3 個主要產品領域，每項 examples 以 1-2 個具體例子為目標，significance 說明對公司的意義。
- growth、risks：各以 3 點為目標，保留具體原因與一項追蹤訊號，不重複同一個論點。
- financialWatch：以 3 個重要財務或營運指標為目標，說明為何重要以及後續看什麼，不要求缺乏來源的即時數字。
- 所有欄位都要填寫，陣列不可空白；資料不足可明確註明，不要為了湊數編造。

【輸出結構】
<!-- COMPACT_REPORT_START -->
{"company":{"symbol":"${symbol}","overview":"公司做什麼","revenue":"主要收入來源與收費方式","customers":"主要客戶或付費者"},"products":[{"name":"主要產品領域","examples":["具體產品或服務"],"significance":"對公司的意義"}],"growth":[{"driver":"成長動能","reason":"具體原因與影響","watch":"追蹤訊號"}],"risks":[{"risk":"具體風險","reason":"具體原因與影響","watch":"追蹤訊號"}],"financialWatch":[{"metric":"財務或營運指標","importance":"為什麼重要","watch":"後續觀察方向"}]}
<!-- COMPACT_REPORT_END -->
`;

module.exports = { getBasePrompt, normalizeSymbol, detectMarket, buildSearchQueries };
