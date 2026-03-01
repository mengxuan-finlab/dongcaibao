function scrollDown() {
  window.scrollBy({
    top: window.innerHeight,
    behavior: 'smooth'
  });
}

document.addEventListener("DOMContentLoaded", function() {
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    const linkSelect = document.getElementById('link-select');
    const linkIntegration = document.getElementById('link-integration');
    const linkService = document.getElementById('link-service');
    const linkNews = document.getElementById('link-news');

    if (linkSelect) linkSelect.href = "core_screener.html";
    if (linkIntegration) linkIntegration.href = "stock_integration.html";
    if (linkService) linkService.href = "financial_statements.html";
    if (linkNews) linkNews.href = "news_tracking.html";
  }
});

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('stockSearch');
    const searchBtn = document.getElementById('doSearch');

    function performSearch() {
        const symbol = searchInput.value.trim().toUpperCase();
        
        if (symbol) {
            window.location.href = `analysis.html?symbol=${symbol}`;
        } else {
            alert("請輸入美股代號（例如：AAPL）");
        }
    }

    if (searchBtn) {
        searchBtn.addEventListener('click', performSearch);
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                performSearch();
            }
        });
    }

    const hotTags = document.querySelectorAll('.hot-tags .tag');
    hotTags.forEach(tag => {
        tag.addEventListener('click', () => {
            const parts = tag.innerText.split(' ');
            const symbol = parts[parts.length - 1];
            window.location.href = `analysis.html?symbol=${symbol}`;
        });
    });
});