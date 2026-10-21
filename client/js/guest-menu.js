(() => {
  const menu = document.getElementById('guest-menu');
  const trigger = document.getElementById('guest-trial-link');

  trigger.addEventListener('click', () => {
    if (!menu.open) menu.showModal();
  });
  document.getElementById('guest-menu-close').addEventListener('click', () => menu.close());
  menu.addEventListener('click', event => {
    if (event.target !== menu) return;
    const bounds = menu.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) menu.close();
  });
  document.getElementById('guest-menu-login').addEventListener('click', () => {
    menu.close();
    document.getElementById('auth-panel').classList.add('show');
    document.getElementById('auth-email').focus();
  });
})();
