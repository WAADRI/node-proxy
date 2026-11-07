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
  // Occupancy as the NODE reports it, with the server's own count as a floor.
  // The server only knows about the work it dispatched and tore down, so during
  // the 2026-10 tunnel-slot leak this card read 8 while the nodes sat at their
  // limit and refused everything. See clientLoad on the server.
  pendingReqs: () =>
    store.status
      ? store.status.clients.reduce(
          (s, c) => s + Math.max(Number(c.clientStats?.activeRequests) || 0, c.pendingRequestsCount || 0),
          0
        )
      : 0,
  tunnels: () =>
    store.status
      ? store.status.clients.reduce(
          (s, c) => s + Math.max(Number(c.clientStats?.activeTunnels) || 0, c.pendingTunnelsCount || 0),
          0
        )
      : 0,
  // Sum of what the nodes will accept, so the card above can be judged against it.
  capacity: () =>
    store.status
      ? store.status.clients.reduce((s, c) => s + (Number(c.clientStats?.maxConcurrentRequests) || 0), 0)
      : 0,
  // A node running an older client reports no capacity; say nothing rather than
  // claiming a limit of 0.
  tunnelsUnit: () => {
    const cap = stats.capacity();
    return cap > 0 ? `条 / 上限 ${cap} 条` : '条';
  },
  tunnelsHint: () =>
    stats.capacity() > 0
      ? '节点自报的活跃隧道数；上限为各节点上报的并发上限之和'
      : '节点自报的活跃隧道数（旧版客户端不上报容量）',
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
function cbTone() {
  if (!store.status) return 'success';
  const open = (store.status.clients || []).some((c) => c.circuitBreaker && c.circuitBreaker.state === 'open');
  return open ? 'danger' : 'success';
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
const trafficClientId = ref(null);
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
    <!-- Overview / endpoints -->
    <section class="wb-hero np-panel">
      <div class="wb-hero-copy">
        <div class="wb-eyebrow">
          <span class="np-dot" :class="store.wsState === 'connected' ? 'alive' : 'dead'"></span>
          SYSTEM OVERVIEW
        </div>
        <h2>代理网关运行概览</h2>
        <p>节点状态、请求吞吐与流量趋势，一屏掌握。</p>
      </div>
      <div class="wb-endpoints">
        <div class="wb-endpoints-label">接入端口</div>
        <div class="wb-endpoint-grid">
          <span class="wb-endpoint" title="HTTP / HTTPS 共用 8080，HTTPS 通过 CONNECT 隧道"><b>HTTP</b><code>:8080</code></span>
          <span class="wb-endpoint" title="HTTP / HTTPS 共用 8080，HTTPS 通过 CONNECT 隧道"><b>HTTPS</b><code>:8080</code></span>
          <span class="wb-endpoint"><b>SOCKS5</b><code>:1080</code></span>
          <span class="wb-endpoint"><b>Web</b><code>:3000</code></span>
        </div>
      </div>
    </section>

    <!-- Stat cards row 1 -->
    <div class="wb-cards">
      <StatCard label="在线节点" :value="stats.total()" unit="个" icon="server" tone="primary" />
      <StatCard label="待处理请求" :value="stats.pendingReqs()" unit="个" icon="activity" tone="cyan" hint="各节点自报活跃请求数与服务端在途请求数的较大值之和" />
      <StatCard
        label="活跃隧道"
        :value="stats.tunnels()"
        :unit="stats.tunnelsUnit()"
        :hint="stats.tunnelsHint()"
        icon="layers"
        tone="violet"
      />
      <StatCard label="服务器运行时间" :value="stats.uptime() ? formatUptime(stats.uptime()) : '-'" icon="clock" tone="success" />
    </div>

    <!-- Stat cards row 2 -->
    <div class="wb-cards">
      <StatCard label="路由策略" :value="routingLabel()" icon="route" tone="primary" accent />
      <StatCard label="熔断器" :value="cbText()" icon="shield" :tone="cbTone()" accent />
      <StatCard label="带宽限制" :value="bwText()" icon="gauge" tone="warning" accent />
      <StatCard label="总失败数" :value="stats.failed()" icon="alert" tone="danger" />
      <StatCard
        label="总流量"
        :value="formatBytes(stats.trafficBytes())"
        hint="全部节点本进程会话累计流量（上行 + 下行）"
        icon="database"
        tone="cyan"
      />
    </div>

    <!-- Daily traffic -->
    <div class="wb-traffic np-panel">
      <div class="wb-traffic-head">
        <div class="wb-traffic-title">
          <span class="wb-traffic-icon"><AppIcon name="chart" :size="16" /></span>
          <div>
            <b>每日流量统计</b>
            <span class="wb-traffic-sub">近 7 天，上行 + 下行</span>
          </div>
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
              <span class="up"><i class="ts-arrow">↑</i>{{ formatBytes(trafficSummary().todayUp) }}</span>
              <span class="down"><i class="ts-arrow">↓</i>{{ formatBytes(trafficSummary().todayDown) }}</span>
            </span>
          </div>
          <div class="ts-item">
            <span class="ts-label">近 7 天合计</span>
            <span class="ts-value">
              <span class="up"><i class="ts-arrow">↑</i>{{ formatBytes(trafficSummary().weekUp) }}</span>
              <span class="down"><i class="ts-arrow">↓</i>{{ formatBytes(trafficSummary().weekDown) }}</span>
            </span>
          </div>
          <div class="ts-item">
            <span class="ts-label">历史累计</span>
            <span class="ts-value">
              <span class="up"><i class="ts-arrow">↑</i>{{ formatBytes(trafficSummary().totalUp) }}</span>
              <span class="down"><i class="ts-arrow">↓</i>{{ formatBytes(trafficSummary().totalDown) }}</span>
            </span>
          </div>
        </div>

        <div v-if="traffic && traffic.daily && traffic.daily.length" class="wb-chart-wrap">
          <div class="wb-chart-grid" aria-hidden="true"></div>
          <div class="wb-chart">
            <div
              v-for="day in traffic.daily"
              :key="day.date"
              class="wb-day"
              :title="day.date + ': 上行 ' + formatBytes(day.bytesSent || 0) + ' / 下行 ' + formatBytes(day.bytesReceived || 0)"
            >
              <div v-if="(day.bytesSent || 0) + (day.bytesReceived || 0) === 0" class="wb-day-zero">0</div>
              <div v-else class="wb-day-bars">
                <div class="tc-bar up" :style="{ height: Math.max(3, Math.round(((day.bytesSent || 0) / trafficMax()) * 132)) + 'px' }"></div>
                <div class="tc-bar down" :style="{ height: Math.max(3, Math.round(((day.bytesReceived || 0) / trafficMax()) * 132)) + 'px' }"></div>
              </div>
              <span class="wb-day-label">{{ day.date.slice(5) }}</span>
            </div>
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
.wb {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Overview banner ----------------------------------------------------------- */
.wb-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 26px;
  padding: 20px 24px;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(520px 160px at 0% 0%, rgba(var(--np-primary-rgb), 0.17), transparent 70%),
    radial-gradient(420px 180px at 100% 100%, rgba(var(--np-violet-rgb), 0.11), transparent 70%),
    var(--np-panel-bg);
}
.wb-hero::after {
  content: '';
  position: absolute;
  right: -60px;
  top: -90px;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  border: 1px solid rgba(var(--np-primary-rgb), 0.12);
  box-shadow: 0 0 0 38px rgba(var(--np-primary-rgb), 0.035), 0 0 0 76px rgba(var(--np-primary-rgb), 0.02);
  pointer-events: none;
}
.wb-hero-copy { position: relative; z-index: 1; min-width: 0; }
.wb-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--np-text-muted);
}
.wb-hero h2 {
  margin: 7px 0 5px;
  font-size: 20px;
  line-height: 1.25;
  letter-spacing: -0.02em;
}
.wb-hero p {
  margin: 0;
  font-size: 12.5px;
  color: var(--np-text-muted);
}
.wb-endpoints {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 0 2px 22px;
  border-left: 1px solid var(--np-border-soft);
}
.wb-endpoints-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--np-text-muted);
}
.wb-endpoint-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.wb-endpoint {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--np-border-soft);
  white-space: nowrap;
}
.wb-endpoint b {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--np-text-muted);
}
.wb-endpoint code {
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 11.5px;
  color: var(--np-text);
}
.wb-endpoint small {
  font-size: 9px;
  color: var(--np-text-muted);
  letter-spacing: 0.04em;
}

/* Cards --------------------------------------------------------------------- */
.wb-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
  gap: 12px;
}

/* Daily traffic ------------------------------------------------------------- */
.wb-traffic {
  position: relative;
  overflow: hidden;
  padding: 18px 20px 16px;
}
.wb-traffic-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}
.wb-traffic-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wb-traffic-title b {
  display: block;
  font-size: 14px;
}
.wb-traffic-icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--np-primary);
  background: rgba(var(--np-primary-rgb), 0.1);
  border: 1px solid rgba(var(--np-primary-rgb), 0.16);
  flex: none;
}
.wb-traffic-sub {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
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
  margin-bottom: 14px;
}
.ts-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: rgba(148, 163, 184, 0.045);
  border: 1px solid var(--np-border-soft);
  border-radius: 11px;
  padding: 10px 13px;
}
.ts-label {
  font-size: 11.5px;
  color: var(--np-text-muted);
}
.ts-value {
  font-size: 13px;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-variant-numeric: tabular-nums;
}
.ts-value .up,
.ts-value .down {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.ts-value .up { color: var(--np-primary); }
.ts-value .down { color: var(--np-violet); }
.ts-arrow {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-style: normal;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--np-primary-rgb), 0.1);
}
.ts-value .down .ts-arrow {
  background: rgba(var(--np-violet-rgb), 0.12);
}
.wb-chart-wrap {
  position: relative;
  min-height: 176px;
  border-bottom: 1px solid var(--np-border-soft);
  padding-top: 4px;
}
.wb-chart-grid {
  position: absolute;
  inset: 4px 0 22px;
  background-image: repeating-linear-gradient(
    to top,
    transparent 0,
    transparent 43px,
    var(--np-border-soft) 43px,
    var(--np-border-soft) 44px
  );
  opacity: 0.55;
  pointer-events: none;
}
.wb-chart {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 10px;
  align-items: flex-end;
  min-height: 172px;
  padding: 6px 2px 0;
  overflow-x: auto;
}
.wb-day {
  flex: 1;
  min-width: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  height: 164px;
}
.wb-day-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
}
.tc-bar {
  width: 13px;
  border-radius: 5px 5px 2px 2px;
  transition: transform 0.18s ease, filter 0.18s ease;
}
.wb-day:hover .tc-bar {
  transform: translateY(-2px);
  filter: brightness(1.12);
}
.wb-day-zero {
  font-size: 11px;
  color: var(--np-text-muted);
  height: 132px;
  display: flex;
  align-items: center;
}
.wb-day-label {
  font-size: 11px;
  color: var(--np-text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.wb-chart-empty {
  text-align: center;
  color: var(--np-text-muted);
  font-size: 13px;
  padding: 44px 0;
}
.wb-legend {
  display: flex;
  gap: 10px;
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--np-text-2);
}
.wb-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.06);
  border: 1px solid var(--np-border-soft);
}
.wb-legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 3px;
}

@media (max-width: 900px) {
  .wb-hero { flex-direction: column; align-items: stretch; gap: 16px; padding: 18px; }
  .wb-endpoints { padding: 14px 0 0; border-left: 0; border-top: 1px solid var(--np-border-soft); }
  .wb-endpoint-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .wb-endpoint { justify-content: center; }
}
@media (max-width: 600px) {
  .wb-hero h2 { font-size: 18px; }
  .wb-endpoint-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wb-traffic { padding: 15px 14px 14px; }
}
</style>
