// ===========================================================================
// API client - same token contract as the legacy panel (np_token / cookie)
// ===========================================================================
const TOKEN_KEY = 'np_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  document.cookie = 'token=' + token + '; path=/; max-age=86400';
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  document.cookie = 'token=; path=/; max-age=0';
}

export function apiFetch(path, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(opts.headers || {}) };
  if (!opts.headers.Authorization) {
    opts.headers.Authorization = 'Bearer ' + getToken();
  }
  if (opts.body && typeof opts.body === 'object') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(path, opts).then(async (r) => {
    if (r.status === 401) {
      clearToken();
      window.location.href = '/login';
      throw new Error('未认证，正在跳转登录页');
    }
    const text = await r.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error('服务器响应异常 (HTTP ' + r.status + ')');
    }
    if (!r.ok && !data.success) {
      throw new Error(data.message || ('HTTP ' + r.status));
    }
    return data;
  });
}

// --- typed helpers ----------------------------------------------------------
export const fetchStatus = () => apiFetch('/api/status');
export const fetchTraffic = (params = {}) => {
  const q = new URLSearchParams();
  q.set('days', String(params.days || 7));
  if (params.clientId) q.set('client_id', params.clientId);
  return apiFetch('/api/v1/traffic?' + q.toString());
};
export const fetchSettings = () => apiFetch('/api/v1/settings');
export const saveSettingsGroup = (group, values) =>
  apiFetch('/api/v1/settings/' + encodeURIComponent(group), { method: 'POST', body: values });
export const resetSettingsGroup = (group) =>
  apiFetch('/api/v1/settings/' + encodeURIComponent(group) + '/reset', { method: 'POST' });
export const broadcast = (message) => apiFetch('/api/broadcast', { method: 'POST', body: { message } });
export const kickClient = (clientId) => apiFetch('/api/kick/' + encodeURIComponent(clientId), { method: 'POST' });
export const saveClientMeta = (clientId, field, value) =>
  apiFetch('/api/v1/client/' + encodeURIComponent(clientId) + '/' + field, {
    method: 'POST',
    body: { [field]: value },
  });
export const fetchRequestLogs = (limit = 100) =>
  apiFetch('/api/v1/logs?limit=' + limit);
