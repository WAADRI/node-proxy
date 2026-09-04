<script setup>
import { computed, h, onMounted, ref } from 'vue';
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
          bodyColor: '#0d1117',
          cardColor: '#161b22',
          modalColor: '#161b22',
          popoverColor: '#1c2128',
          tableColor: '#0d1117',
          tableHeaderColor: '#161b22',
          borderColor: '#30363d',
          dividerColor: '#21262d',
          primaryColor: '#2f81f7',
          primaryColorHover: '#58a6ff',
          primaryColorPressed: '#1f6feb',
          primaryColorSuppl: '#1f6feb',
          infoColor: '#58a6ff',
          successColor: '#3fb950',
          warningColor: '#d29922',
          errorColor: '#f85149',
          textColorBase: '#e6edf3',
          textColor1: '#e6edf3',
          textColor2: '#c9d1d9',
          textColor3: '#8b949e',
        },
      }
    : {
        common: {
          bodyColor: '#ffffff',
          cardColor: '#ffffff',
          modalColor: '#ffffff',
          popoverColor: '#ffffff',
          tableColor: '#ffffff',
          tableHeaderColor: '#f6f8fa',
          borderColor: '#d0d7de',
          dividerColor: '#d8dee4',
          primaryColor: '#0969da',
          primaryColorHover: '#0550ae',
          primaryColorPressed: '#0969da',
          primaryColorSuppl: '#0969da',
          infoColor: '#0969da',
          successColor: '#1a7f37',
          warningColor: '#9a6700',
          errorColor: '#cf222e',
          textColorBase: '#1f2328',
          textColor1: '#1f2328',
          textColor2: '#3d444d',
          textColor3: '#656d76',
        },
      }
);

// Nav ------------------------------------------------------------------------
const navItems = [
  { name: 'workbench', path: '/', label: '工作台', icon: 'grid' },
  { name: 'nodes', path: '/nodes', label: '节点管理', icon: 'server' },
  { name: 'logs', path: '/logs', label: '请求日志', icon: 'list' },
  { name: 'settings', path: '/settings', label: '系统设置', icon: 'sliders' },
];

// Header menu ----------------------------------------------------------------
const showBroadcast = ref(false);
const showKickAllConfirm = ref(false);

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
          <!-- Left side nav -->
          <aside class="np-side">
            <div class="np-brand">
              <div class="np-brand-mark">NP</div>
              <div class="np-brand-text">
                <div class="np-brand-name">Node-Proxy</div>
                <div class="np-brand-sub">控制面板</div>
              </div>
            </div>
            <nav class="np-nav">
              <router-link
                v-for="item in navItems"
                :key="item.name"
                :to="item.path"
                class="np-nav-item"
                :class="{ active: route.name === item.name }"
              >
                <AppIcon :name="item.icon" :size="17" />
                <span>{{ item.label }}</span>
              </router-link>
            </nav>
            <div class="np-side-foot">
              <div class="np-side-stat">在线 <b>{{ topTotal }}</b> 节点</div>
              <div class="np-side-stat">运行 {{ uptimeText }}</div>
            </div>
          </aside>

          <!-- Right content -->
          <div class="np-main">
            <header class="np-top">
              <div class="np-top-title">{{ route.meta.title || '' }}</div>
              <div class="np-top-right">
                <span class="np-conn">
                  <i class="np-dot" :class="store.wsState === 'connected' ? 'alive' : 'dead'"></i>
                  {{ connText }}
                </span>
                <span class="np-updated" title="最后更新时间">{{ lastUpdateText }}</span>
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
              <router-view />
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
.np-app {
  display: flex;
  min-height: 100vh;
}
.np-side {
  width: 200px;
  flex: none;
  background: var(--np-bg-soft);
  border-right: 1px solid var(--np-border-soft);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
}
.np-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 16px 14px;
}
.np-brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--np-primary), #8b5cf6);
  color: #fff;
  font-weight: 800;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.np-brand-name { font-weight: 700; font-size: 14px; }
.np-brand-sub { font-size: 11px; color: var(--np-text-muted); }
.np-nav {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.np-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  color: var(--np-text-2);
  text-decoration: none;
  font-size: 13.5px;
}
.np-nav-item:hover { background: var(--np-bg-hover); color: var(--np-text); }
.np-nav-item.active {
  background: var(--np-primary);
  color: #fff;
}
.np-side-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--np-border-soft);
  font-size: 12px;
  color: var(--np-text-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.np-side-stat b { color: var(--np-text-2); }
.np-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.np-top {
  height: 54px;
  flex: none;
  border-bottom: 1px solid var(--np-border-soft);
  background: var(--np-bg-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  position: sticky;
  top: 0;
  z-index: 50;
}
.np-top-title { font-size: 15px; font-weight: 700; }
.np-top-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.np-conn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--np-text-2);
  background: var(--np-bg-hover);
  border: 1px solid var(--np-border-soft);
  border-radius: 999px;
  padding: 4px 12px;
}
.np-updated {
  font-size: 12px;
  color: var(--np-text-muted);
}
.np-icon-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--np-border-soft);
  background: transparent;
  color: var(--np-text-2);
  cursor: pointer;
}
.np-icon-btn:hover {
  background: var(--np-bg-hover);
  color: var(--np-text);
}
.np-content {
  flex: 1;
  padding: 18px 22px 30px;
  min-width: 0;
}
</style>
