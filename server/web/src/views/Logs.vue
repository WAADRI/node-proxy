<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { NButton, NDataTable, NTag, NEmpty } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import { store, requestLogs, clearRequestLogs } from '../store';

// ---------------------------------------------------------------------------
// Request log view: live proxy request entries (time / IP / domain / status)
// ---------------------------------------------------------------------------
const paused = ref(false);
const frozen = ref([]);
const loading = ref(false);

const live = computed(() => store.requestLogs);
const shown = computed(() => (paused.value ? frozen.value : live.value));
const connected = computed(() => store.wsState === 'connected');

watch(paused, (p) => {
  if (p) frozen.value = [...live.value];
});

const counts = computed(() => {
  let tunnel = 0;
  let ok = 0;
  let fail = 0;
  for (const row of shown.value) {
    if (row.method === 'CONNECT' || row.kind === 'tunnel') tunnel++;
    else if (row.status >= 200 && row.status < 400) ok++;
    else if (row.status >= 400) fail++;
  }
  return { total: shown.value.length, tunnel, ok, fail };
});

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(ts) {
  const d = new Date(ts);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmtClock(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function prettyUrl(u) {
  if (!u) return '-';
  const s = String(u);
  // Tunnel entries are recorded as 'host:port' (see recordTunnelLog in ws-server.ts), which is NOT
  // a URL: new URL('gdtv-api.gdtv.cn:443') reads the host as the SCHEME and '443' as the path, so
  // url.host was empty and this column displayed nothing but the port (and threw outright for a
  // bare IP such as '129.80.7.65:443'). Only rewrite when an explicit scheme:// is present.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  try {
    const url = new URL(s);
    return url.host + url.pathname + url.search;
  } catch (_) {
    return s;
  }
}

function methodClass(row) {
  const m = String(row.method || 'GET').toLowerCase().replace(/[^a-z]/g, '');
  return 'm-' + (m || 'get');
}

function statusLabel(row) {
  if (row.method === 'CONNECT' || row.kind === 'tunnel') return '隧道';
  if (!row.status) return '—';
  return String(row.status);
}
function statusType(row) {
  if (row.method === 'CONNECT' || row.kind === 'tunnel') return 'info';
  if (row.status >= 500) return 'error';
  if (row.status >= 400) return 'warning';
  if (row.status >= 300) return 'info';
  if (row.status >= 200) return 'success';
  return 'default';
}

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + ' s';
}
function msClass(ms) {
  if (ms >= 10000) return 'slow';
  if (ms >= 3000) return 'warn';
  return '';
}

function refresh() {
  loading.value = true;
  requestLogs(500)
    .catch(() => {})
    .finally(() => (loading.value = false));
}

function clearAll() {
  clearRequestLogs();
  frozen.value = [];
}

const columns = [
  {
    title: '时间',
    key: 'time',
    width: 124,
    render: (row) =>
      h('div', { class: 'log-time' }, [
        h('span', { class: 'log-date' }, fmtDate(row.ts)),
        h('span', { class: 'log-clock' }, fmtClock(row.ts)),
      ]),
  },
  {
    title: '来源 IP',
    key: 'ip',
    width: 138,
    render: (row) => h('span', { class: 'log-ip' }, row.ip || '-'),
  },
  {
    title: '方法',
    key: 'method',
    width: 92,
    render: (row) =>
      h('span', { class: ['log-method', methodClass(row)] }, row.method || 'GET'),
  },
  {
    title: '目标域名 / 路径',
    key: 'url',
    minWidth: 260,
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'log-url' }, prettyUrl(row.url)),
  },
  {
    // Issue #107: an HTTPS session shows only the CONNECT target above, which is
    // a bare IP for many clients. The SNI from the TLS handshake names the site.
    title: 'SNI（TLS 域名）',
    key: 'sni',
    minWidth: 190,
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'log-sni' }, row.sni || '—'),
  },
  {
    title: '状态',
    key: 'status',
    width: 86,
    render: (row) =>
      h(
        NTag,
        {
          size: 'small',
          bordered: false,
          type: statusType(row),
          class: ['log-status', row.method === 'CONNECT' || row.kind === 'tunnel' ? 'is-tunnel' : ''],
        },
        { default: () => statusLabel(row) }
      ),
  },
  {
    title: '耗时',
    key: 'ms',
    width: 96,
    render: (row) =>
      h('span', { class: ['log-ms', msClass(row.ms)] }, fmtMs(row.ms)),
  },
];

onMounted(() => {
  // Always reconcile with the server snapshot on entry. The merge in
  // requestLogs() keeps live WS entries and sorts the result newest-first.
  refresh();
});
</script>

<template>
  <div class="logs">
    <!-- Header / actions -->
    <section class="logs-head np-panel">
      <div class="logs-head-copy">
        <div class="logs-eyebrow">
          <span class="np-dot" :class="connected ? 'alive' : 'dead'"></span>
          LIVE REQUEST FEED
        </div>
        <h2>代理请求实时记录</h2>
        <p>按时间倒序排列，最新请求始终显示在最上面 · 保留最近 500 条</p>
      </div>
      <div class="logs-actions">
        <span class="np-live-pill" :class="{ 'is-offline': !connected }">
          <i class="np-dot" :class="connected ? 'alive' : 'dead'"></i>
          {{ connected ? '实时推送中' : '推送未连接' }}
        </span>
        <NButton size="small" secondary :loading="loading" @click="refresh">
          <template #icon><AppIcon name="refresh" :size="14" /></template>
          刷新
        </NButton>
        <NButton size="small" secondary :type="paused ? 'primary' : 'default'" @click="paused = !paused">
          {{ paused ? '继续滚动' : '暂停' }}
        </NButton>
        <NButton size="small" secondary @click="clearAll">清空显示</NButton>
      </div>
    </section>

    <!-- Quick counters -->
    <div class="logs-stats">
      <div class="ls-item">
        <span class="ls-label">显示记录</span>
        <b class="ls-value">{{ counts.total }}</b>
      </div>
      <div class="ls-item ok">
        <span class="ls-label">HTTP 成功</span>
        <b class="ls-value">{{ counts.ok }}</b>
      </div>
      <div class="ls-item bad">
        <span class="ls-label">HTTP 失败</span>
        <b class="ls-value">{{ counts.fail }}</b>
      </div>
      <div class="ls-item tunnel">
        <span class="ls-label">CONNECT 隧道</span>
        <b class="ls-value">{{ counts.tunnel }}</b>
      </div>
    </div>

    <!-- Table -->
    <section class="logs-table np-panel">
      <div class="logs-table-head">
        <span class="logs-table-title">请求明细</span>
        <span class="logs-order">
          <AppIcon name="arrow-down" :size="12" />
          最新在上
        </span>
      </div>
      <NDataTable
        :columns="columns"
        :data="shown"
        :loading="loading"
        size="small"
        :max-height="620"
        :scroll-x="1120"
        :row-key="(row) => row.seq"
        :row-class-name="(row) => (row.method === 'CONNECT' || row.kind === 'tunnel' ? 'log-tunnel-row' : '')"
        :bordered="false"
        :single-line="false"
        class="np-table"
      >
        <template #empty>
          <NEmpty description="暂无请求日志 — 浏览器/客户端通过代理访问后这里会实时显示" />
        </template>
      </NDataTable>
    </section>
  </div>
</template>

<style scoped>
.logs {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 18px 20px;
  background:
    radial-gradient(460px 140px at 0% 0%, rgba(var(--np-primary-rgb), 0.15), transparent 70%),
    var(--np-panel-bg);
}
.logs-head-copy { min-width: 0; }
.logs-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--np-text-muted);
}
.logs-head h2 {
  margin: 7px 0 5px;
  font-size: 19px;
  letter-spacing: -0.02em;
}
.logs-head p {
  margin: 0;
  font-size: 12px;
  color: var(--np-text-muted);
}
.logs-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.logs-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.ls-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  background: var(--np-panel-bg);
  border: 1px solid var(--np-border-soft);
  border-radius: 12px;
  position: relative;
  overflow: hidden;
}
.ls-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--np-text-muted);
  opacity: 0.35;
}
.ls-item.ok::before { background: var(--np-success); opacity: 0.8; }
.ls-item.bad::before { background: var(--np-danger); opacity: 0.8; }
.ls-item.tunnel::before { background: var(--np-violet); opacity: 0.8; }
.ls-label {
  font-size: 11.5px;
  color: var(--np-text-muted);
}
.ls-value {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.ls-item.ok .ls-value { color: var(--np-success); }
.ls-item.bad .ls-value { color: var(--np-danger); }
.ls-item.tunnel .ls-value { color: var(--np-violet); }
.logs-table {
  padding: 4px 4px 2px;
  overflow: hidden;
}
.logs-table-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 16px 9px;
}
.logs-table-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--np-text-2);
}
.logs-order {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--np-text-muted);
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--np-border-soft);
}
.logs-table :deep(.n-data-table-th) {
  font-size: 11px;
  letter-spacing: 0.04em;
}
.logs-table :deep(.n-data-table-td) {
  font-size: 12.5px;
}
.logs-table :deep(.n-data-table-tr.log-tunnel-row .n-data-table-td) {
  background: rgba(var(--np-violet-rgb), 0.025);
}
.logs-table :deep(.log-time) {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  font-variant-numeric: tabular-nums;
}
.logs-table :deep(.log-date) {
  font-size: 10.5px;
  color: var(--np-text-muted);
}
.logs-table :deep(.log-clock) {
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 12px;
  color: var(--np-text-2);
}
.logs-table :deep(.log-ip) {
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 11.5px;
  color: var(--np-text-muted);
}
.logs-table :deep(.log-method) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  padding: 1px 8px;
  border-radius: 6px;
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  border: 1px solid transparent;
}
.logs-table :deep(.log-method.m-get) { color: var(--np-primary); background: rgba(var(--np-primary-rgb), 0.1); border-color: rgba(var(--np-primary-rgb), 0.18); }
.logs-table :deep(.log-method.m-post) { color: var(--np-violet); background: rgba(var(--np-violet-rgb), 0.1); border-color: rgba(var(--np-violet-rgb), 0.18); }
.logs-table :deep(.log-method.m-connect) { color: var(--np-warning); background: rgba(var(--np-warning-rgb), 0.09); border-color: rgba(var(--np-warning-rgb), 0.18); }
.logs-table :deep(.log-method.m-put) { color: var(--np-cyan); background: rgba(var(--np-cyan-rgb), 0.09); border-color: rgba(var(--np-cyan-rgb), 0.18); }
.logs-table :deep(.log-method.m-delete) { color: var(--np-danger); background: rgba(var(--np-danger-rgb), 0.09); border-color: rgba(var(--np-danger-rgb), 0.18); }
.logs-table :deep(.log-url) {
  color: var(--np-text);
  font-size: 12.5px;
}
.logs-table :deep(.log-sni) {
  color: var(--np-text-muted);
  font-size: 12px;
}
.logs-table :deep(.log-ms) {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--np-text-2);
}
.logs-table :deep(.log-ms.warn) { color: var(--np-warning); }
.logs-table :deep(.log-ms.slow) { color: var(--np-danger); }
.logs-table :deep(.log-status.is-tunnel) {
  color: var(--np-violet);
  background: rgba(var(--np-violet-rgb), 0.1);
}
@media (max-width: 900px) {
  .logs-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .logs-head { padding: 16px; }
}
@media (max-width: 600px) {
  .logs-actions { width: 100%; }
  .logs-actions .np-live-pill { margin-right: auto; }
}
</style>
