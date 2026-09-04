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

watch(paused, (p) => {
  if (p) frozen.value = [...live.value];
});

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return (
    p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

function prettyUrl(u) {
  if (!u) return '-';
  try {
    const url = new URL(u);
    return url.host + url.pathname + url.search;
  } catch (_) {
    return u;
  }
}

function statusType(s) {
  if (s >= 500) return 'error';
  if (s >= 400) return 'warning';
  if (s >= 300) return 'info';
  if (s >= 200) return 'success';
  return 'default';
}

function refresh() {
  loading.value = true;
  requestLogs(200)
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
    width: 150,
    render: (row) => fmtTime(row.ts),
  },
  {
    title: '来源 IP',
    key: 'ip',
    width: 150,
    render: (row) => row.ip || '-',
  },
  {
    title: '方法',
    key: 'method',
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, style: 'font-family: monospace' },
        { default: () => row.method || 'GET' }
      ),
  },
  {
    title: '目标域名 / 路径',
    key: 'url',
    minWidth: 260,
    ellipsis: { tooltip: true },
    render: (row) => prettyUrl(row.url),
  },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: statusType(row.status) },
        { default: () => (row.status ? String(row.status) : '-') }
      ),
  },
  {
    title: '耗时',
    key: 'ms',
    width: 90,
    render: (row) => (row.ms != null ? row.ms + ' ms' : '-'),
  },
];

onMounted(() => {
  if (store.requestLogs.length === 0) refresh();
});
</script>

<template>
  <div class="logs">
    <!-- Toolbar -->
    <div class="logs-toolbar">
      <span class="logs-title">
        代理请求实时记录（保留最近
        <b>500</b>
        条）
      </span>
      <span class="logs-hint">
        <i class="np-dot" :class="store.wsState === 'connected' ? 'alive' : 'dead'"></i>
        {{ store.wsState === 'connected' ? '实时推送中' : '实时推送未连接，请刷新' }}
      </span>
      <div class="logs-actions">
        <NButton size="small" secondary :loading="loading" @click="refresh">
          <template #icon><AppIcon name="refresh" :size="14" /></template>
          刷新
        </NButton>
        <NButton size="small" secondary :type="paused ? 'primary' : 'default'" @click="paused = !paused">
          {{ paused ? '继续滚动' : '暂停' }}
        </NButton>
        <NButton size="small" secondary @click="clearAll">清空显示</NButton>
      </div>
    </div>

    <!-- Table -->
    <NDataTable
      :columns="columns"
      :data="shown"
      :loading="loading"
      size="small"
      :max-height="620"
      :scroll-x="900"
      :row-key="(row) => row.seq"
    >
      <template #empty>
        <NEmpty description="暂无请求日志 — 浏览器/客户端通过代理访问后这里会实时显示" />
      </template>
    </NDataTable>
  </div>
</template>

<style scoped>
.logs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.logs-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.logs-title {
  font-size: 13.5px;
  color: var(--np-text-2);
}
.logs-title b {
  color: var(--np-primary);
}
.logs-hint {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--np-text-muted);
}
.logs-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.np-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: var(--np-border-soft);
}
.np-dot.alive {
  background: #3fb950;
}
.np-dot.dead {
  background: var(--np-danger);
}
</style>
