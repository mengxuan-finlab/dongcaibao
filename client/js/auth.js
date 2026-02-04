// Supabase 設定
  const supabaseUrl = "https://zlkexplsleznuebighte.supabase.co";
  const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpsa2V4cGxzbGV6bnVlYmlnaHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0MzAwNjUsImV4cCI6MjA4MTAwNjA2NX0.HPVn3jcN88M4U3-RCVW-YO-b65rDOKv6pxEaVWwbm68";

  const supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);

  // ✅ 1. 登入後幫他確保 profiles 有一筆資料
  async function ensureProfile() {
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      console.error("取得使用者失敗：", userError);
      return;
    }

    const { data: profile, error } = await supabaseClient
      .from("profiles")
      .select("id, plan")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      console.error("讀取 profile 失敗：", error);
      return;
    }

    if (!profile) {
      const { error: insertError } = await supabaseClient.from("profiles").insert({
        id: user.id,
        email: user.email,
        plan: "free", // 預設方案
      });
      if (insertError) {
        console.error("建立 profile 失敗：", insertError);
      }
    }
  }

  // ✅ 2. 更新右上角 UI（顯示登入人 email + 方案）
  async function refreshAuthUI() {
    const authUserEl = document.getElementById("auth-user");
    const logoutBtn = document.getElementById("logout-btn");
    const openPanelBtn = document.getElementById("open-auth-panel");

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      authUserEl.style.display = "none";
      logoutBtn.style.display = "none";
      openPanelBtn.style.display = "inline-flex";
      return;
    }

    const { data: profile, error } = await supabaseClient
      .from("profiles")
      .select("plan")
      .eq("id", user.id)
      .maybeSingle();

    const plan = profile?.plan || "free";

    authUserEl.textContent = `${user.email}｜方案：${plan}`;
    authUserEl.style.display = "inline-flex";
    logoutBtn.style.display = "inline-flex";
    openPanelBtn.style.display = "none";
  }

  // ✅ 3. 開關小面板
  const authPanel = document.getElementById("auth-panel");
  const openPanelBtn = document.getElementById("open-auth-panel");
  const authErrorEl = document.getElementById("auth-error");

  openPanelBtn.addEventListener("click", () => {
    authPanel.classList.toggle("show");
    authErrorEl.style.display = "none";
    authErrorEl.textContent = "";
  });

  // ✅ 4. 按「登入」
  document.getElementById("do-login").addEventListener("click", async () => {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;

    authErrorEl.style.display = "none";
    authErrorEl.textContent = "";

    if (!email || !password) {
      authErrorEl.textContent = "請輸入 Email 和密碼";
      authErrorEl.style.display = "block";
      return;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      authErrorEl.textContent = "登入失敗：" + error.message;
      authErrorEl.style.display = "block";
      return;
    }

    // 登入成功 → 有 session → RLS 才讓你寫 profiles
    await ensureProfile();
    authPanel.classList.remove("show");
    await refreshAuthUI();
  });

  // ✅ 5. 按「註冊」
document.getElementById("do-signup").addEventListener("click", async () => {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const authErrorEl = document.getElementById("auth-error");

    authErrorEl.style.display = "none";
    authErrorEl.textContent = "";

    // 1. 基本檢查
    if (!email || !password) {
      authErrorEl.textContent = "請輸入 Email 和密碼";
      authErrorEl.style.display = "block";
      return;
    }
    if (password.length < 6) {
      authErrorEl.textContent = "密碼長度需至少 6 碼";
      authErrorEl.style.display = "block";
      return;
    }

    // 2. 執行註冊
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin, 
      }
    });

    // 3. 錯誤處理 (這裡捕捉格式錯誤、密碼太弱等)
    if (error) {
      console.error("註冊錯誤:", error);
      authErrorEl.textContent = "註冊失敗：" + error.message;
      authErrorEl.style.display = "block";
      return;
    }

    // 4. 成功處理 (通用訊息)
    // 這裡的邏輯是：無論是新帳號(真的註冊成功) 還是舊帳號(Supabase 假裝成功)，
    // 前端都顯示這段話，讓使用者自己去確認。
    
    alert(`請求已送出！\n\n已將通知發送至 ${email}。\n若您尚未註冊，請前往信箱點擊連結啟用帳號。\n若此 Email 曾經註冊過，請直接登入即可。`);
    
    // 關閉面板並清空欄位
    document.getElementById("auth-panel").classList.remove("show");
    document.getElementById("auth-email").value = "";
    document.getElementById("auth-password").value = "";
});

  // ✅ 6. 登出
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    await refreshAuthUI();
  });
  // 在你的 auth.js 中更新 handleCheckout 函式
  async function handleCheckout(event) {
      event.preventDefault();
      
      // 💡 修正：使用 currentTarget 確保精準抓到 <a> 標籤本體
      const btn = event.currentTarget; 
      if (!btn || !btn.href) return;

      // 從 Supabase 領取身分證 (ID)
      const { data: { user } } = await supabaseClient.auth.getUser();

      if (!user) {
          alert("請先登入後再進行訂閱！");
          return;
      }

      // 💡 修正：最原始但最有效的拼接方式
      const userId = user.id;
      const separator = btn.href.includes('?') ? '&' : '?';
      const checkoutUrl = `${btn.href}${separator}passthrough[user_id]=${userId}`;

      console.log("🚀 正確生成的網址（請確認最後有 ID）:", checkoutUrl);
      window.location.href = checkoutUrl;
  }
  // 綁定事件：確保監聽所有 lemonsqueezy-button
  document.querySelectorAll('.lemonsqueezy-button').forEach(btn => {
      btn.addEventListener('click', handleCheckout);
  });
  // ✅ 新增：初始化按鈕的函式
  async function initButtons() {
      console.log("正在尋找訂閱按鈕...");
      const buttons = document.querySelectorAll('.lemonsqueezy-button');
      console.log(`找到 ${buttons.length} 個按鈕`);

      buttons.forEach(btn => {
          // 先移除舊的監聽器，避免重複綁定導致跳轉兩次
          btn.removeEventListener('click', handleCheckout);
          btn.addEventListener('click', handleCheckout);
      });
  }
  // ✅ 7. 頁面載入時先更新一次狀態
  window.addEventListener("DOMContentLoaded", () => {
    refreshAuthUI();
    initButtons();   // 💡 關鍵：必須執行這個函式，才能讓按鈕學會「帶 ID 跳轉」
  });

  // 你原本的 scrollDown
  function scrollDown() {
    const nextSection = document.querySelector("#service") || document.querySelector("#home");
    if (nextSection) {
      nextSection.scrollIntoView({ behavior: "smooth" });
    }
  }