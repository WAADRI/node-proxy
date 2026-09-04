import { reactive } from 'vue';
import { fetchStatus } from './api';

export const THEME_KEY = 'np_theme';

// ---------------------------------------------------------------------------
// Global reactive store (single source of truth shared by all pages)
// ---------------------------------------------------------------------------
export const store = reactive({
  status: null, // latest /api/status payload (also fed by /web-ws)
  wsState: 'disconnected', // connected | disconnected
  lastUpdate: null, // timestamp of last status update
  role: localStorage.getItem('np_role') || '',
  theme: localStorage.getItem(THEME_KEY) || 'dark', // dark | light
});

export function applyTheme(theme) {
  store.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

export function toggleTheme() {
  applyTheme(store.theme === 'dark' ? 'light' : 'dark');
}

// ---------------------------------------------------------------------------
// Live WebSocket updates (/web-ws) with 3s auto-reconnect
// ---------------------------------------------------------------------------
let ws = null;
let reconnectTimer = null;

export function connectWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('np_token') || '';
  ws = new WebSocket(`${proto}//${window.location.host}/web-ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    store.wsState = 'connected';
    clearTimeout(reconnectTimer);
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        store.status = msg.data;
        store.lastUpdate = Date.now();
      }
    } catch (err) {
      console.error('WS parse error', err);
    }
  };
  ws.onclose = () => {
    store.wsState = 'disconnected';
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose follows
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 3000);
}

// ---------------------------------------------------------------------------
// Manual refresh fallback
// ---------------------------------------------------------------------------
export function requestStatus() {
  return fetchStatus()
    .then((data) => {
      store.status = data;
      store.lastUpdate = Date.now();
      return data;
    })
    .catch((err) => {
      throw err;
    });
}
