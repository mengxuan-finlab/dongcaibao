const supabaseUrl = "https://zlkexplsleznuebighte.supabase.co";
  const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpsa2V4cGxzbGV6bnVlYmlnaHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0MzAwNjUsImV4cCI6MjA4MTAwNjA2NX0.HPVn3jcN88M4U3-RCVW-YO-b65rDOKv6pxEaVWwbm68";

  window.supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);
  const supabaseClient = window.supabaseClient;

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
        plan: "free",
      });
      if (insertError) {
        console.error("建立 profile 失敗：", insertError);
      }
    }
  }

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

  function setupPasswordToggle() {
    const toggleBtn = document.getElementById("toggle-password");
    const passwordInput = document.getElementById("auth-password");

    if (toggleBtn && passwordInput) {
      toggleBtn.addEventListener("click", () => {
        const isPassword = passwordInput.type === "password";
        passwordInput.type = isPassword ? "text" : "password";
        toggleBtn.textContent = isPassword ? "🙈" : "👁️";
      });
    }
  }

  const authPanel = document.getElementById("auth-panel");
  const openPanelBtn = document.getElementById("open-auth-panel");
  const authErrorEl = document.getElementById("auth-error");

  openPanelBtn.addEventListener("click", () => {
    authPanel.classList.toggle("show");
    authErrorEl.style.display = "none";
    authErrorEl.textContent = "";
  });

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

    await ensureProfile();
    authPanel.classList.remove("show");
    await refreshAuthUI();
  });

  document.getElementById("do-signup").addEventListener("click", async () => {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const authErrorEl = document.getElementById("auth-error");

    authErrorEl.style.display = "none";
    authErrorEl.textContent = "";

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

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin, 
      }
    });

    if (error) {
      console.error("註冊錯誤:", error);
      authErrorEl.textContent = "註冊失敗：" + error.message;
      authErrorEl.style.display = "block";
      return;
    }

    alert(`請求已送出！\n\n已將通知發送至 ${email}。\n若您尚未註冊，請前往信箱點擊連結啟用帳號。\n若此 Email 曾經註冊過，請直接登入即可。`);
    
    document.getElementById("auth-panel").classList.remove("show");
    document.getElementById("auth-email").value = "";
    document.getElementById("auth-password").value = "";
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    await refreshAuthUI();
  });

  async function handleCheckout(event) {
    event.preventDefault();

    const btn = event.currentTarget;
    if (!btn || !btn.href) return;

    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
      alert("請先登入後再進行訂閱！");
      return;
    }

    const userId = user.id;
    const url = new URL(btn.href);

    url.searchParams.set('checkout[custom][user_id]', userId);

    const checkoutUrl = url.toString();
    window.location.href = checkoutUrl;
  }

  document.querySelectorAll('.lemonsqueezy-button')
    .forEach(btn => btn.addEventListener('click', handleCheckout));

  function startBindingProcess() {
      let checkCount = 0;
      const maxChecks = 20;

      const checkAndBind = setInterval(() => {
          checkCount++;
          const buttons = document.querySelectorAll('.lemonsqueezy-button');
          
          if (buttons.length > 0) {
              buttons.forEach(btn => {
                  btn.removeEventListener('click', handleCheckout);
                  btn.addEventListener('click', handleCheckout);
              });
              clearInterval(checkAndBind); 
          } else if (checkCount >= maxChecks) {
              console.error("❌ [懂才抱] 找不到訂閱按鈕，請確認 HTML 中的 class 名稱是否正確");
              clearInterval(checkAndBind);
          }
      }, 500);
  }

  window.addEventListener("load", () => {
      refreshAuthUI();
      startBindingProcess();
      setupPasswordToggle();
  });

  function scrollDown() {
    const nextSection = document.querySelector("#service") || document.querySelector("#home");
    if (nextSection) {
      nextSection.scrollIntoView({ behavior: "smooth" });
    }
  }