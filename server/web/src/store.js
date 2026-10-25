import { reactive } from 'vue';
import { fetchStatus, fetchRequestLogs } from './api';

export const THEME_KEY = 'np_theme';

// Keep the same window as the server-side ring buffer (see LogHub maxEntries).
const MAX_LOG_ENTRIES = 500;

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
// Newest first is the single invariant of the request-log view. The API returns
// history in that order (see web-server.ts), but WebSocket entries and a refresh
// can race: sorting by seq here keeps the table stable no matter which arrives
// first and dedupes replayed entries after a reconnect.
function sortNewestFirst(a, b) {
  return (Number(b.seq) || 0) - (Number(a.seq) || 0);
}

function prependLog(entry) {
  if (!entry || entry.seq == null) return;
  const logs = store.requestLogs;
  if (logs.some((e) => e.seq === entry.seq)) return; // dedupe
  // Normal path appends to the front; an out-of-order replay is inserted in
  // place so the array never flips into ascending order.
  if (logs.length === 0 || Number(entry.seq) > Number(logs[0].seq)) {
    logs.unshift(entry);
  } else {
    const at = logs.findIndex((e) => Number(e.seq) < Number(entry.seq));
    if (at === -1) logs.push(entry);
    else logs.splice(at, 0, entry);
  }
  if (logs.length > MAX_LOG_ENTRIES) logs.length = MAX_LOG_ENTRIES;
}

export function requestLogs(limit = MAX_LOG_ENTRIES) {
  return fetchRequestLogs(limit)
    .then((data) => {
      // Merge history with anything the live socket already delivered, keyed by
      // seq (the server's monotonic id), then enforce newest-first order.
      const bySeq = new Map();
      for (const entry of data.logs || []) {
        if (entry && entry.seq != null) bySeq.set(entry.seq, entry);
      }
      // Live entries win over the history snapshot: they may carry the same seq
      // but arrived after the request was issued.
      for (const entry of store.requestLogs) {
        if (entry && entry.seq != null) bySeq.set(entry.seq, entry);
      }
      store.requestLogs = [...bySeq.values()].sort(sortNewestFirst).slice(0, MAX_LOG_ENTRIES);
      return data;
    })
    .catch((err) => {
      throw err;
    });
}

export function clearRequestLogs() {
  store.requestLogs = [];
}
