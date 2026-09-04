import { reactive } from 'vue';
import { fetchStatus, fetchRequestLogs } from './api';

export const THEME_KEY = 'np_theme';

const MAX_LOG_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Global reactive store (single source of truth shared by all pages)
// ---------------------------------------------------------------------------
export const store = reactive({
  status: null, // latest /api/status payload (also fed by /web-ws)
  wsState: 'disconnected', // connected | disconnected
  lastUpdate: null, // timestamp of last status update
  role: localStorage.getItem('np_role') || '',
  theme: localStorage.getItem(THEME_KEY) || 'dark', // dark | light
  requestLogs: [], // recent proxy request entries (newest first)
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
      } else if (msg.type === 'log' && msg.data) {
        prependLog(msg.data);
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

// ---------------------------------------------------------------------------
// Request log helpers
// ---------------------------------------------------------------------------
function prependLog(entry) {
  const logs = store.requestLogs;
  if (logs.length && logs[0].seq === entry.seq) return; // dedupe
  logs.unshift(entry);
  if (logs.length > MAX_LOG_ENTRIES) logs.length = MAX_LOG_ENTRIES;
}

export function requestLogs(limit = 100) {
  return fetchRequestLogs(limit)
    .then((data) => {
      // merge: keep any newer live entries already received, fill with history
      const seen = new Set(store.requestLogs.map((e) => e.seq));
      const fresh = (data.logs || []).filter((e) => !seen.has(e.seq));
      store.requestLogs = fresh.concat(store.requestLogs).slice(0, MAX_LOG_ENTRIES);
      return data;
    })
    .catch((err) => {
      throw err;
    });
}

export function clearRequestLogs() {
  store.requestLogs = [];
}
