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

    // 2. 執行註冊 (🔥這裡加了一點優化)
    // window.location.origin 會自動抓目前的網址 (例如 localhost:3000 或你的正式網址)
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin, 
      }
    });

    // 3. 錯誤處理
    if (error) {
      console.error("註冊錯誤:", error);
      authErrorEl.textContent = "註冊失敗：" + error.message;
      authErrorEl.style.display = "block";
      return;
    }

    // 4. 成功處理
    // 提示多加了一句，讓使用者知道信是從哪裡寄來的
    alert(`註冊成功！\n請前往信箱 (${email}) 收取驗證信。\n寄件者會顯示 Doncaibao Team。`);
    
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

  // ✅ 7. 頁面載入時先更新一次狀態
  window.addEventListener("DOMContentLoaded", () => {
    refreshAuthUI();
  });

  // 你原本的 scrollDown
  function scrollDown() {
    const nextSection = document.querySelector("#service") || document.querySelector("#home");
    if (nextSection) {
      nextSection.scrollIntoView({ behavior: "smooth" });
    }
  }