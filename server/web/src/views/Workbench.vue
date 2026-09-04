<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { NSelect, NButton } from 'naive-ui';
import { useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import StatCard from '../components/StatCard.vue';
import { store } from '../store';
import { fetchTraffic } from '../api';
import { formatBytes, formatUptime } from '../utils';

const message = useMessage();

const STRATEGY_LABELS = {
  random: '随机',
  'least-loaded': '最少负载',
  'fastest-response': '最快响应',
  weighted: '加权',
};

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------
const stats = {
  total: () => (store.status ? store.status.total || 0 : 0),
  clients: () => (store.status ? store.status.clients || [] : []),
  pendingReqs: () => (store.status ? store.status.clients.reduce((s, c) => s + (c.pendingRequestsCount || 0), 0) : 0),
  tunnels: () => (store.status ? store.status.clients.reduce((s, c) => s + (c.pendingTunnelsCount || 0), 0) : 0),
  uptime: () => (store.status && store.status.server && store.status.server.uptime ? store.status.server.uptime : null),
  failed: () => (store.status && store.status.server ? store.status.server.failedRequests || 0 : 0),
  trafficBytes: () =>
    store.status && store.status.server
      ? (store.status.server.totalBytesSent || 0) + (store.status.server.totalBytesReceived || 0)
      : 0,
};

function routingLabel() {
  const r = store.status && store.status.routing;
  if (!r) return '-';
  return STRATEGY_LABELS[r.strategy] || r.strategy || 'random';
}
function cbText() {
  if (!store.status) return '-';
  const open = (store.status.clients || []).filter((c) => c.circuitBreaker && c.circuitBreaker.state === 'open').length;
  return open > 0 ? open + ' 个熔断' : '正常';
}
function bwText() {
  const b = store.status && store.status.bandwidth;
  return b ? (b.enabled ? '已开启' : '关闭') : '-';
}

// ---------------------------------------------------------------------------
// Daily traffic (frp-style bar chart)
// ---------------------------------------------------------------------------
const traffic = ref(null); // { today, daily[], totals }
const trafficLoading = ref(false);
const trafficClientId = ref('');
const trafficTimer = null;

const trafficOptions = () => {
  const clients = (store.status && store.status.clients) || [];
  return clients.map((c) => ({
    label: c.alias || (c.info && c.info.hostname) || c.id.substring(0, 8) + '…',
    value: c.id,
  }));
};

async function loadTrafficChart() {
  trafficLoading.value = true;
  try {
    const d = await fetchTraffic({ days: 7, clientId: trafficClientId.value || undefined });
    traffic.value = d;
  } catch (err) {
    message.error('流量统计加载失败: ' + err.message);
  } finally {
    trafficLoading.value = false;
  }
}

const trafficSummary = () => {
  if (!traffic.value) return null;
  const daily = traffic.value.daily || [];
  const sum = daily.reduce(
    (a, x) => ({ sent: a.sent + (x.bytesSent || 0), recv: a.recv + (x.bytesReceived || 0) }),
    { sent: 0, recv: 0 }
  );
  const t = traffic.value.totals || {};
  const scope =
    trafficClientId.value && trafficOptions().length
      ? (trafficOptions().find((o) => o.value === trafficClientId.value) || {}).label || '节点'
      : '全部节点';
  return {
    scope,
    todayUp: (traffic.value.today && traffic.value.today.bytesSent) || 0,
    todayDown: (traffic.value.today && traffic.value.today.bytesReceived) || 0,
    weekUp: sum.sent,
    weekDown: sum.recv,
    totalUp: t.bytesSent || 0,
    totalDown: t.bytesReceived || 0,
  };
};

const trafficMax = () => {
  const daily = (traffic.value && traffic.value.daily) || [];
  return Math.max(1, ...daily.map((x) => (x.bytesSent || 0) + (x.bytesReceived || 0)));
};

let trafficInterval = null;
onMounted(() => {
  loadTrafficChart();
  trafficInterval = setInterval(() => {
    // refresh only when the section is visible (workbench is default route)
    loadTrafficChart().catch(() => {});
  }, 60000);
});
onUnmounted(() => {
  if (trafficInterval) clearInterval(trafficInterval);
});
</script>

<template>
  <div class="wb">
    <!-- Ports -->
    <div class="wb-ports">
      <span class="wb-ports-label">
        <AppIcon name="chart" :size="15" /> 代理端口
      </span>
      <span class="wb-port"><b>HTTP</b> :8080</span>
      <span class="wb-port"><b>HTTPS</b> :8080 (CONNECT)</span>
      <span class="wb-port"><b>SOCKS5</b> :1080</span>
      <span class="wb-port"><b>Web</b> :3000</span>
    </div>

    <!-- Stat cards row 1 -->
    <div class="wb-cards">
      <StatCard label="在线节点" :value="stats.total()" />
      <StatCard label="总请求数" :value="stats.pendingReqs()" unit="待处理" />
      <StatCard label="活跃隧道" :value="stats.tunnels()" unit="条" />
      <StatCard label="服务器运行时间" :value="stats.uptime() ? formatUptime(stats.uptime()) : '-'" />
    </div>

    <!-- Stat cards row 2 -->
    <div class="wb-cards">
      <StatCard label="路由策略" :value="routingLabel()" />
      <StatCard label="熔断器" :value="cbText()" />
      <StatCard label="带宽限制" :value="bwText()" />
      <StatCard label="总失败数" :value="stats.failed()" />
      <StatCard label="总流量" :value="formatBytes(stats.trafficBytes())" hint="全部节点本进程会话累计流量（上行 + 下行）" />
    </div>

    <!-- Daily traffic -->
    <div class="wb-traffic">
      <div class="wb-traffic-head">
        <div class="wb-traffic-title">
          <AppIcon name="chart" :size="16" />
          <b>每日流量统计</b>
          <span class="wb-traffic-sub">近 7 天，上行 + 下行</span>
        </div>
        <div class="wb-traffic-tools">
          <NSelect
            v-model:value="trafficClientId"
            :options="trafficOptions()"
            placeholder="全部节点"
            clearable
            size="small"
            style="width: 180px"
            @update:value="loadTrafficChart()"
          />
          <NButton size="small" quaternary circle :loading="trafficLoading" @click="loadTrafficChart()">
            <AppIcon name="refresh" :size="15" />
          </NButton>
        </div>
      </div>

      <template v-if="trafficSummary()">
        <div class="wb-traffic-summary">
          <div class="ts-item">
            <span class="ts-label">{{ trafficSummary().scope }} · 今日</span>
            <span class="ts-value">
              <span class="up">↑ {{ formatBytes(trafficSummary().todayUp) }}</span>
              <span class="down">↓ {{ formatBytes(trafficSummary().todayDown) }}</span>
            </span>
          </div>
          <div class="ts-item">
            <span class="ts-label">近 7 天合计</span>
            <span class="ts-value">
              <span class="up">↑ {{ formatBytes(trafficSummary().weekUp) }}</span>
              <span class="down">↓ {{ formatBytes(trafficSummary().weekDown) }}</span>
            </span>
          </div>
          <div class="ts-item">
            <span class="ts-label">历史累计</span>
            <span class="ts-value">
              <span class="up">↑ {{ formatBytes(trafficSummary().totalUp) }}</span>
              <span class="down">↓ {{ formatBytes(trafficSummary().totalDown) }}</span>
            </span>
          </div>
        </div>

        <div v-if="traffic && traffic.daily && traffic.daily.length" class="wb-chart">
          <div
            v-for="day in traffic.daily"
            :key="day.date"
            class="wb-day"
            :title="day.date + ': 上行 ' + formatBytes(day.bytesSent || 0) + ' / 下行 ' + formatBytes(day.bytesReceived || 0)"
          >
            <div v-if="(day.bytesSent || 0) + (day.bytesReceived || 0) === 0" class="wb-day-zero">0</div>
            <div v-else class="wb-day-bars">
              <div class="tc-bar up" :style="{ height: Math.max(2, Math.round(((day.bytesSent || 0) / trafficMax()) * 130)) + 'px' }"></div>
              <div class="tc-bar down" :style="{ height: Math.max(2, Math.round(((day.bytesReceived || 0) / trafficMax()) * 130)) + 'px' }"></div>
            </div>
            <span class="wb-day-label">{{ day.date.slice(5) }}</span>
          </div>
        </div>
        <div v-else class="wb-chart-empty">暂无数据</div>

        <div class="wb-legend">
          <span><i class="tc-bar up"></i> 上行</span>
          <span><i class="tc-bar down"></i> 下行</span>
        </div>
      </template>
      <div v-else class="wb-chart-empty">加载中...</div>
    </div>
  </div>
</template>

<style scoped>
.wb { display: flex; flex-direction: column; gap: 14px; }
.wb-ports {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  background: var(--np-bg-soft);
  border: 1px solid var(--np-border-soft);
  border-radius: 10px;
  padding: 10px 14px;
}
.wb-ports-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  margin-right: 4px;
}
.wb-port {
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 12px;
  color: var(--np-text-2);
  background: var(--np-muted-chip);
  border-radius: 6px;
  padding: 3px 8px;
}
.wb-port b { color: var(--np-text); margin-right: 2px; }
.wb-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.wb-traffic {
  background: var(--np-bg-soft);
  border: 1px solid var(--np-border-soft);
  border-radius: 12px;
  padding: 16px 18px;
}
.wb-traffic-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.wb-traffic-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-traffic-sub {
  font-size: 12px;
  color: var(--np-text-muted);
}
.wb-traffic-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-traffic-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.ts-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--np-bg);
  border: 1px solid var(--np-border-soft);
  border-radius: 8px;
  padding: 8px 12px;
}
.ts-label { font-size: 12px; color: var(--np-text-muted); }
.ts-value { font-size: 13px; display: flex; gap: 12px; font-variant-numeric: tabular-nums; }
.ts-value .up { color: var(--np-primary); }
.ts-value .down { color: var(--np-warning); }
.wb-chart {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  min-height: 170px;
  border-bottom: 1px solid var(--np-border-soft);
  padding: 6px 2px 0;
  overflow-x: auto;
}
.wb-day {
  flex: 1;
  min-width: 42px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 160px;
}
.wb-day-bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
}
.tc-bar { width: 9px; border-radius: 2px 2px 0 0; }
.tc-bar.up { background: var(--np-primary); }
.tc-bar.down { background: var(--np-warning); }
.wb-day-zero {
  font-size: 11px;
  color: var(--np-text-muted);
  height: 130px;
  display: flex;
  align-items: center;
}
.wb-day-label {
  font-size: 11px;
  color: var(--np-text-muted);
  white-space: nowrap;
}
.wb-chart-empty {
  text-align: center;
  color: var(--np-text-muted);
  font-size: 13px;
  padding: 34px 0;
}
.wb-legend {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--np-text-2);
}
.wb-legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: -1px;
}
.wb-legend .tc-bar.up { background: var(--np-primary); }
.wb-legend .tc-bar.down { background: var(--np-warning); }
</style>
