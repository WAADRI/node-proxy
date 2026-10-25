<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NDropdown,
  darkTheme,
  lightTheme,
} from 'naive-ui';
import AppIcon from './components/AppIcon.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import BroadcastDialog from './components/BroadcastDialog.vue';
import MessageBridge from './components/MessageBridge.vue';
import { messageRef } from './msg';
import { store, applyTheme, toggleTheme, connectWebSocket, requestStatus } from './store';
import { clearToken, kickClient } from './api';
import { formatUptime, timeStr } from './utils';

const route = useRoute();
const msg = () => messageRef.value;

// Theme ----------------------------------------------------------------------
const themeObj = computed(() => (store.theme === 'dark' ? darkTheme : lightTheme));
const themeOverrides = computed(() =>
  store.theme === 'dark'
    ? {
        common: {
          bodyColor: '#070a12',
          cardColor: '#0f1626',
          modalColor: '#111a2b',
          popoverColor: '#111a2b',
          tableColor: 'rgba(9, 14, 25, 0.55)',
          tableHeaderColor: '#0b1220',
          borderColor: '#26314a',
          dividerColor: 'rgba(148, 163, 184, 0.12)',
          primaryColor: '#4c8dff',
          primaryColorHover: '#6ea4ff',
          primaryColorPressed: '#2f7bff',
          primaryColorSuppl: '#2f7bff',
          infoColor: '#22d3ee',
          successColor: '#34d399',
          warningColor: '#fbbf24',
          errorColor: '#fb7185',
          textColorBase: '#f1f5fc',
          textColor1: '#f1f5fc',
          textColor2: '#c3cede',
          textColor3: '#8391aa',
          borderRadius: '10px',
          borderRadiusSmall: '8px',
        },
        Card: {
          color: 'rgba(15, 22, 38, 0.82)',
          colorModal: '#111a2b',
          borderColor: 'rgba(148, 163, 184, 0.13)',
          borderRadius: '16px',
          titleFontWeight: '700',
          titleFontSize: '15px',
        },
        DataTable: {
          thColor: '#0b1220',
          thColorHover: '#111b2d',
          tdColor: 'transparent',
          tdColorHover: 'rgba(76, 141, 255, 0.065)',
          tdColorStriped: 'rgba(148, 163, 184, 0.025)',
          borderColor: 'rgba(148, 163, 184, 0.12)',
          thTextColor: '#8391aa',
          tdTextColor: '#c3cede',
          thFontWeight: '600',
        },
        Input: {
          color: 'rgba(7, 10, 18, 0.55)',
          colorFocus: 'rgba(7, 10, 18, 0.75)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          borderHover: '1px solid rgba(76, 141, 255, 0.5)',
          borderFocus: '1px solid #4c8dff',
          boxShadowFocus: '0 0 0 2px rgba(76, 141, 255, 0.16)',
          borderRadius: '9px',
        },
        InternalSelectMenu: {
          color: '#111a2b',
          optionTextColor: '#c3cede',
          optionTextColorActive: '#4c8dff',
          optionColorPending: 'rgba(76, 141, 255, 0.1)',
          optionColorActive: 'rgba(76, 141, 255, 0.14)',
        },
        Button: {
          borderRadiusMedium: '9px',
          borderRadiusSmall: '8px',
          fontWeight: '600',
        },
      }
    : {
        common: {
          bodyColor: '#f3f6fc',
          cardColor: '#ffffff',
          modalColor: '#ffffff',
          popoverColor: '#ffffff',
          tableColor: 'rgba(255, 255, 255, 0.72)',
          tableHeaderColor: '#f7f9fe',
          borderColor: '#d7e0ee',
          dividerColor: 'rgba(37, 99, 235, 0.1)',
          primaryColor: '#2563eb',
          primaryColorHover: '#1d4ed8',
          primaryColorPressed: '#1e40af',
          primaryColorSuppl: '#1e40af',
          infoColor: '#0891b2',
          successColor: '#059669',
          warningColor: '#b45309',
          errorColor: '#dc2626',
          textColorBase: '#0f1a2e',
          textColor1: '#0f1a2e',
          textColor2: '#3b4a63',
          textColor3: '#6b7a93',
          borderRadius: '10px',
          borderRadiusSmall: '8px',
        },
        Card: {
          color: 'rgba(255, 255, 255, 0.92)',
          colorModal: '#ffffff',
          borderColor: 'rgba(37, 99, 235, 0.1)',
          borderRadius: '16px',
          titleFontWeight: '700',
          titleFontSize: '15px',
        },
        DataTable: {
          thColor: '#f7f9fe',
          thColorHover: '#eef4ff',
          tdColor: 'transparent',
          tdColorHover: 'rgba(37, 99, 235, 0.045)',
          tdColorStriped: 'rgba(37, 99, 235, 0.02)',
          borderColor: 'rgba(37, 99, 235, 0.1)',
          thTextColor: '#6b7a93',
          tdTextColor: '#3b4a63',
          thFontWeight: '600',
        },
        Input: {
          color: 'rgba(255, 255, 255, 0.82)',
          colorFocus: '#ffffff',
          border: '1px solid rgba(37, 99, 235, 0.14)',
          borderHover: '1px solid rgba(37, 99, 235, 0.4)',
          borderFocus: '1px solid #2563eb',
          boxShadowFocus: '0 0 0 2px rgba(37, 99, 235, 0.13)',
          borderRadius: '9px',
        },
        InternalSelectMenu: {
          color: '#ffffff',
          optionTextColor: '#3b4a63',
          optionTextColorActive: '#2563eb',
          optionColorPending: 'rgba(37, 99, 235, 0.08)',
          optionColorActive: 'rgba(37, 99, 235, 0.11)',
        },
        Button: {
          borderRadiusMedium: '9px',
          borderRadiusSmall: '8px',
          fontWeight: '600',
        },
      }
);

// Nav ------------------------------------------------------------------------
const navItems = [
  { name: 'workbench', path: '/', label: '工作台', icon: 'grid' },
  { name: 'nodes', path: '/nodes', label: '节点管理', icon: 'server' },
  { name: 'logs', path: '/logs', label: '请求日志', icon: 'list' },
  { name: 'networkTest', path: '/network-test', label: '网络测试', icon: 'radar' },
  { name: 'settings', path: '/settings', label: '系统设置', icon: 'sliders' },
];

const PAGE_SUBTITLE = {
  workbench: '运行概览 · 实时流量 · 服务状态',
  nodes: '在线节点状态与元数据管理',
  logs: '代理请求实时记录 · 最新请求置顶',
  networkTest: '从服务端或节点发起连通性探测',
  settings: '运行参数与分流密码',
};
const pageSubtitle = computed(() => PAGE_SUBTITLE[route.name] || '');

// Header menu ----------------------------------------------------------------
const showBroadcast = ref(false);
const showKickAllConfirm = ref(false);

// Mobile navigation (issue #98): below the layout breakpoint the sidebar becomes
// an off-canvas drawer, so it must be closable and must not stay open across a
// navigation.
const navOpen = ref(false);
watch(
  () => route.fullPath,
  () => {
    navOpen.value = false;
  }
);

const menuOptions = computed(() => [
  { key: 'refresh', label: '刷新数据', icon: () => h(AppIcon, { name: 'refresh', size: 15 }) },
  { key: 'broadcast', label: '广播消息', icon: () => h(AppIcon, { name: 'message', size: 15 }) },
  { type: 'divider', key: 'd1' },
  {
    key: 'kickall',
    label: '断开全部节点',
    icon: () => h(AppIcon, { name: 'kick', size: 15 }),
    props: { style: 'color: var(--np-danger)' },
  },
  {
    key: 'logout',
    label: '退出登录',
    icon: () => h(AppIcon, { name: 'logout', size: 15 }),
    props: { style: 'color: var(--np-danger)' },
  },
]);

function onMenuSelect(key) {
  if (key === 'refresh') {
    requestStatus()
      .then(() => msg()?.success('已刷新'))
      .catch((err) => msg()?.error('刷新失败: ' + err.message));
  } else if (key === 'broadcast') {
    showBroadcast.value = true;
  } else if (key === 'kickall') {
    const online = store.status && store.status.clients ? store.status.clients.length : 0;
    if (online === 0) {
      msg()?.info('没有在线节点');
      return;
    }
    showKickAllConfirm.value = true;
  } else if (key === 'logout') {
    doLogout();
  }
}

function doLogout() {
  clearToken();
  window.location.href = '/login';
}

function kickAllConfirmed() {
  const ids = store.status && store.status.clients ? store.status.clients.map((c) => c.id) : [];
  if (ids.length === 0) return;
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    kickClient(id)
      .then((d) => (d.success ? done++ : failed++))
      .catch(() => failed++)
      .finally(() => {
        if (done + failed === ids.length) {
          if (failed) msg()?.error('断开完成：成功 ' + done + ' 个，失败 ' + failed + ' 个');
          else msg()?.success('已断开 ' + done + ' 个节点');
          requestStatus().catch(() => {});
        }
      });
  }
}

// Connection status ----------------------------------------------------------
const connText = computed(() =>
  store.wsState === 'connected' ? 'WebSocket 已连接 (实时更新)' : 'WebSocket 未连接 (3秒后重连)'
);
const connShort = computed(() => (store.wsState === 'connected' ? '实时连接' : '正在重连'));
const lastUpdateText = computed(() => (store.lastUpdate ? timeStr(store.lastUpdate) : '等待数据...'));
const uptimeText = computed(() => {
  const s = store.status && store.status.server && store.status.server.uptime;
  return s ? formatUptime(s) : '-';
});

const topTotal = computed(() => (store.status ? store.status.total || 0 : 0));

onMounted(() => {
  applyTheme(store.theme); // sync <html data-theme>
  requestStatus().catch(() => {});
  connectWebSocket();
  setInterval(() => {
    if (store.wsState !== 'connected') requestStatus().catch(() => {});
  }, 30000);
});
</script>

<template>
  <NConfigProvider :theme="themeObj" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <MessageBridge />
        <div class="np-app">
          <!-- Mobile drawer backdrop (issue #98): on narrow screens the sidebar
               slides in below the header instead of squeezing the content. -->
          <div v-if="navOpen" class="np-backdrop" @click="navOpen = false"></div>
          <!-- Left side nav -->
          <aside class="np-side" :class="{ open: navOpen }">
            <div class="np-brand">
              <div class="np-brand-mark">
                <span>NP</span>
              </div>
              <div class="np-brand-text">
                <div class="np-brand-name">Node-Proxy</div>
                <div class="np-brand-sub">CONTROL PLANE</div>
              </div>
            </div>
            <div class="np-nav-label">导航</div>
            <nav class="np-nav">
              <router-link
                v-for="item in navItems"
                :key="item.name"
                :to="item.path"
                class="np-nav-item"
                :class="{ active: route.name === item.name }"
              >
                <span class="np-nav-icon"><AppIcon :name="item.icon" :size="16" /></span>
                <span class="np-nav-text">{{ item.label }}</span>
              </router-link>
            </nav>
            <div class="np-side-foot">
              <div class="np-side-stat">
                <span class="np-side-stat-label">
                  <i class="np-dot" :class="topTotal > 0 ? 'alive' : 'idle'"></i>
                  在线节点
                </span>
                <b>{{ topTotal }}</b>
              </div>
              <div class="np-side-stat">
                <span class="np-side-stat-label">
                  <AppIcon name="clock" :size="12" />
                  运行时间
                </span>
                <b>{{ uptimeText }}</b>
              </div>
              <div class="np-side-version">Node-Proxy v3.0 · MIT</div>
            </div>
          </aside>

          <!-- Right content -->
          <div class="np-main">
            <header class="np-top">
              <button
                class="np-icon-btn np-burger"
                :aria-expanded="navOpen ? 'true' : 'false'"
                :title="navOpen ? '收起菜单' : '展开菜单'"
                aria-label="导航菜单"
                @click="navOpen = !navOpen"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18M3 12h18M3 18h18" />
                </svg>
              </button>
              <div class="np-top-heading">
                <div class="np-top-title">{{ route.meta.title || '' }}</div>
                <div class="np-top-sub">{{ pageSubtitle }}</div>
              </div>
              <div class="np-top-right">
                <span class="np-conn" :class="{ offline: store.wsState !== 'connected' }" :title="connText">
                  <i class="np-dot" :class="store.wsState === 'connected' ? 'alive' : 'dead'"></i>
                  <span class="np-conn-text">{{ connShort }}</span>
                </span>
                <span class="np-updated" title="最后更新时间">
                  <AppIcon name="clock" :size="12" />
                  {{ lastUpdateText }}
                </span>
                <button
                  class="np-icon-btn"
                  :title="store.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
                  @click="toggleTheme()"
                >
                  <AppIcon :name="store.theme === 'dark' ? 'sun' : 'moon'" :size="16" />
                </button>
                <NDropdown
                  trigger="click"
                  :options="menuOptions"
                  placement="bottom-end"
                  @select="onMenuSelect"
                >
                  <button class="np-icon-btn" title="更多操作" aria-label="更多操作">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="12" cy="19" r="1.6" />
                    </svg>
                  </button>
                </NDropdown>
              </div>
            </header>
            <main class="np-content">
              <div class="np-page">
                <router-view />
              </div>
            </main>
          </div>
        </div>

        <ConfirmDialog
          v-model:show="showKickAllConfirm"
          title="断开全部节点"
          :message="
            '将断开全部 ' +
            (store.status && store.status.clients ? store.status.clients.length : 0) +
            ' 个在线节点。所有节点上的进行中请求会被终止，客户端会自动重连。'
          "
          require-check
          check-label="我了解该操作会中断全部节点的活动请求"
          ok-text="确认断开全部"
          @ok="kickAllConfirmed"
        />
        <BroadcastDialog v-model:show="showBroadcast" />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
/* ===========================================================================
 * App shell - glassy sidebar + sticky command bar
 * =========================================================================== */
.np-app {
  display: flex;
  min-height: 100vh;
  position: relative;
}
.np-side {
  width: 224px;
  flex: none;
  background: var(--np-side-bg);
  border-right: 1px solid var(--np-border-soft);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
  z-index: 60;
}
.np-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 22px 18px 18px;
}
.np-brand-mark {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(135deg, #4c8dff 0%, #7c6cff 52%, #8b5cf6 100%);
  box-shadow: 0 8px 22px rgba(var(--np-primary-rgb), 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex: none;
}
.np-brand-mark::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  pointer-events: none;
}
.np-brand-name {
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.01em;
}
.np-brand-sub {
  font-size: 9.5px;
  letter-spacing: 0.18em;
  color: var(--np-text-muted);
  margin-top: 3px;
}
.np-nav-label {
  padding: 8px 22px 7px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--np-text-muted);
  text-transform: uppercase;
}
.np-nav {
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.np-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 11px;
  color: var(--np-text-2);
  text-decoration: none;
  font-size: 13.5px;
  position: relative;
  border: 1px solid transparent;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}
.np-nav-item:hover {
  background: var(--np-bg-hover);
  color: var(--np-text);
  border-color: var(--np-border-soft);
}
.np-nav-item.active {
  background: linear-gradient(135deg, rgba(var(--np-primary-rgb), 0.98), rgba(124, 92, 246, 0.92));
  color: #fff;
  border-color: rgba(255, 255, 255, 0.16);
  box-shadow: 0 10px 26px rgba(var(--np-primary-rgb), 0.26);
}
.np-nav-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  background: rgba(148, 163, 184, 0.1);
  color: var(--np-text-muted);
  transition: inherit;
}
.np-nav-item:hover .np-nav-icon { color: var(--np-primary); }
.np-nav-item.active .np-nav-icon {
  background: rgba(255, 255, 255, 0.17);
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.np-nav-text { font-weight: 500; }
.np-side-foot {
  margin: 12px;
  padding: 13px 13px 11px;
  border: 1px solid var(--np-border-soft);
  border-radius: 14px;
  background: rgba(148, 163, 184, 0.045);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.np-side-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--np-text-muted);
}
.np-side-stat-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.np-side-stat b {
  color: var(--np-text);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.np-side-version {
  border-top: 1px solid var(--np-border-soft);
  padding-top: 9px;
  font-size: 10.5px;
  color: var(--np-text-muted);
  letter-spacing: 0.02em;
}
.np-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.np-top {
  height: 68px;
  flex: none;
  border-bottom: 1px solid var(--np-border-soft);
  background: var(--np-header-bg);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  backdrop-filter: blur(18px) saturate(140%);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 26px;
  position: sticky;
  top: 0;
  z-index: 50;
}
.np-top-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.np-top-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-top-sub {
  font-size: 11.5px;
  color: var(--np-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-top-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.np-icon-btn.np-burger { display: none; }
.np-conn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  font-size: 12px;
  color: var(--np-text-2);
  background: rgba(var(--np-success-rgb), 0.08);
  border: 1px solid rgba(var(--np-success-rgb), 0.2);
  border-radius: 999px;
  padding: 0 12px;
  white-space: nowrap;
}
.np-conn.offline {
  background: var(--np-danger-bg);
  border-color: rgba(var(--np-danger-rgb), 0.24);
}
.np-updated {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--np-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.np-icon-btn {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid var(--np-border-soft);
  background: rgba(148, 163, 184, 0.045);
  color: var(--np-text-2);
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}
.np-icon-btn:hover {
  background: var(--np-bg-hover);
  color: var(--np-primary);
  border-color: rgba(var(--np-primary-rgb), 0.35);
  transform: translateY(-1px);
}
.np-content {
  flex: 1;
  padding: 22px 26px 34px;
  min-width: 0;
}
.np-page {
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
  animation: np-rise 0.34s ease both;
}

/* ===========================================================================
 * Responsive layout: below 900px the sidebar becomes a drawer.
 * =========================================================================== */
@media (max-width: 1100px) {
  .np-updated { display: none; }
}
@media (max-width: 900px) {
  .np-icon-btn.np-burger { display: inline-flex; }
  .np-side {
    position: fixed;
    top: 68px;
    left: 0;
    bottom: 0;
    height: auto;
    width: min(268px, 80vw);
    z-index: 110;
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    box-shadow: var(--np-shadow-lg);
    overflow-y: auto;
  }
  .np-side.open { transform: translateX(0); }
  .np-backdrop {
    position: fixed;
    top: 68px;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 100;
    background: rgba(2, 6, 23, 0.52);
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
  }
  .np-top {
    z-index: 130;
    padding: 0 14px;
    gap: 10px;
  }
  .np-top-sub { display: none; }
  .np-conn { padding: 0 9px; }
  .np-conn-text { display: none; }
  .np-content { padding: 14px 14px 26px; }
  .np-nav-item { padding: 10px; font-size: 14px; }
  .np-nav-icon { width: 30px; height: 30px; }
  .np-icon-btn { width: 36px; height: 36px; }
}
@media (max-width: 600px) {
  .np-top { height: 58px; padding: 0 10px; }
  .np-side,
  .np-backdrop { top: 58px; }
  .np-top-title { font-size: 14.5px; }
  .np-top-right { gap: 6px; }
  .np-content { padding: 12px 10px 22px; }
  .np-side-foot { padding: 10px 12px; }
}
</style>
