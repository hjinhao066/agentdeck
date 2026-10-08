'use strict';
// 入口登录页：账号口令只在这里输一次，发给 /gate/login 换一个长期 cookie，页面不保存账号口令。
(function () {
  try {
    const saved = localStorage.getItem('agentdeck-hub-theme');
    const dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.dataset.theme = 'dark';
  } catch (_) { /* 没有本地存储就跟随系统。 */ }

  const form = document.getElementById('gate-form');
  const user = document.getElementById('gate-user');
  const pass = document.getElementById('gate-pass');
  const error = document.getElementById('gate-error');
  const submit = document.getElementById('gate-submit');
  const eye = document.getElementById('gate-eye');

  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    const label = show ? '隐藏口令' : '显示口令';
    eye.title = label; eye.setAttribute('aria-label', label); eye.setAttribute('aria-pressed', String(show));
    // SVG 元素没有 .hidden 属性，要用 toggleAttribute。
    eye.querySelector('.eye-on').toggleAttribute('hidden', show);
    eye.querySelector('.eye-off').toggleAttribute('hidden', !show);
  });

  // 账号口令里可能有中文，先转成 UTF-8 字节再做 Base64（btoa 只认单字节字符）。
  function basic(u, p) {
    const bytes = new TextEncoder().encode(u + ':' + p);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return 'Basic ' + btoa(binary);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const response = await fetch('/gate/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Authorization: basic(user.value, pass.value) },
      });
      if (response.status === 204) { pass.value = ''; location.replace('/' + location.hash); return; }
      error.textContent = response.status === 401 ? '账号或口令不对，请重试。' : '暂时无法登录，请重试。';
    } catch (_) {
      error.textContent = '无法连接，请检查网络后重试。';
    } finally {
      submit.disabled = false;
    }
  });
})();
