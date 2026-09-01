// =============================================================================
// Node-Proxy Login Page
// =============================================================================
(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const btn = document.getElementById('loginBtn');
  const errorMsg = document.getElementById('errorMsg');

  // Redirect if already logged in
  const token = localStorage.getItem('np_token') || getCookie('token');
  if (token) {
    checkToken(token);
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  function checkToken(token) {
    fetch('/api/status', {
      headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(r => {
      if (r.ok) {
        window.location.href = '/';
      } else {
        localStorage.removeItem('np_token');
      }
    })
    .catch(() => {
      localStorage.removeItem('np_token');
    });
  }

  window.doLogin = async function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span>登录中...';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.value.trim(),
          password: password.value,
        }),
      });

      const data = await res.json();

      if (data.success && data.token) {
        localStorage.setItem('np_token', data.token);
        document.cookie = 'token=' + data.token + '; path=/; max-age=86400';
        window.location.href = data.redirect || '/';
      } else {
        errorMsg.textContent = data.message || '登录失败，请检查用户名和密码';
        btn.disabled = false;
        btn.textContent = '登 录';
        password.value = '';
        password.focus();
      }
    } catch (err) {
      errorMsg.textContent = '网络错误，请检查服务器连接';
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  };
})();