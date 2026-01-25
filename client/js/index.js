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
