/*按鈕*/
function scrollDown() {
      window.scrollBy({
        top: window.innerHeight,
        behavior: 'smooth'
      });
    }
// client/js/index.js
document.addEventListener("DOMContentLoaded", function() {
  // 判斷是否為手機版 (螢幕寬度小於或等於 768px)
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    // 1. 抓取你 HTML 裡設定的 link- 系列 ID
    const linkSelect = document.getElementById('link-select');
    const linkIntegration = document.getElementById('link-integration');
    const linkService = document.getElementById('link-service');
    const linkNews = document.getElementById('link-news');

    // 2. 手機版：將 # 錨點連結 替換為 實際的功能頁面
    if (linkSelect) linkSelect.href = "core_screener.html";
    if (linkIntegration) linkIntegration.href = "stock_integration.html";
    if (linkService) linkService.href = "financial_statements.html";
    if (linkNews) linkNews.href = "news_tracking.html";
  
  }
});
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('stockSearch');
    const searchBtn = document.getElementById('doSearch');

    // 執行搜尋跳轉的函式
    function performSearch() {
        const symbol = searchInput.value.trim().toUpperCase();
        
        if (symbol) {
            // 跳轉至財報快照頁面，並帶上 symbol 參數
            window.location.href = `analysis.html?symbol=${symbol}`;
        } else {
            alert("請輸入美股代號（例如：AAPL）");
        }
    }

    // 點擊按鈕搜尋
    if (searchBtn) {
        searchBtn.addEventListener('click', performSearch);
    }

    // 按下 Enter 鍵也能搜尋
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                performSearch();
            }
        });
    }

    // 針對下方熱門標籤 (hot-tags) 點擊直接搜尋
    const hotTags = document.querySelectorAll('.hot-tags .tag');
    hotTags.forEach(tag => {
        tag.addEventListener('click', () => {
            // 取得標籤文字最後一個單字 (即代號，如 NVDA)
            const parts = tag.innerText.split(' ');
            const symbol = parts[parts.length - 1];
            window.location.href = `analysis.html?symbol=${symbol}`;
        });
    });
});