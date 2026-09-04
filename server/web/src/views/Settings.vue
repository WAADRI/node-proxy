<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NInputNumber, NSwitch, NTag, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { fetchSettings, saveSettingsGroup, resetSettingsGroup } from '../api';
import { requestStatus } from '../store';

const message = useMessage();

const STRATEGY_LABELS = {
  random: '随机',
  'least-loaded': '最少负载',
  'fastest-response': '最快响应',
  weighted: '加权',
};
const STRATEGY_DESC = {
  random: '从在线节点中随机选择',
  'least-loaded': '优先选择待处理请求最少的节点',
  'fastest-response': '优先选择平均响应最快的节点',
  weighted: '按节点权重比例分配（权重在节点行调整）',
};

const data = ref(null); // full GET payload
const loading = ref(true);
const savingGroup = ref('');

const rt = computed(() => (data.value ? data.value.runtime || {} : {}));
const editable = computed(() => (data.value ? data.value.editable || {} : {}));
const restartOnly = computed(() => (data.value ? data.value.restart_only || {} : {}));

const curStrategy = computed(() => (rt.value.routing && rt.value.routing.strategy) || 'random');
const availStrategy = computed(
  () => (rt.value.routing && rt.value.routing.available) || Object.keys(STRATEGY_LABELS)
);

function load() {
  loading.value = true;
  fetchSettings()
    .then((d) => {
      data.value = d;
    })
    .catch((err) => message.error('加载设置失败: ' + err.message))
    .finally(() => {
      loading.value = false;
    });
}

// --- numeric field model (bound to runtime values once loaded) ---------------
const fieldValues = ref({});
function v(key) {
  return fieldValues.value[key];
}
function setFromRuntime() {
  const r = rt.value;
  fieldValues.value = {
    strategy: curStrategy.value,
    cbErrorThreshold: r.circuit_breaker ? r.circuit_breaker.error_threshold : null,
    cbWindowMs: r.circuit_breaker ? r.circuit_breaker.window_ms : null,
    cbRecoveryMs: r.circuit_breaker ? r.circuit_breaker.recovery_timeout_ms : null,
    cbHalfOpen: r.circuit_breaker ? r.circuit_breaker.half_open_max_attempts : null,
    bwEnabled: !!(r.bandwidth && r.bandwidth.enabled),
    bwGlobalRateKb: r.bandwidth && r.bandwidth.global_rate != null ? Math.round(r.bandwidth.global_rate / 1024) : 0,
    bwDefaultRateKb: r.bandwidth && r.bandwidth.default_rate != null ? Math.round(r.bandwidth.default_rate / 1024) : 0,
    clRequestTimeout: r.client ? r.client.request_timeout : null,
    clTunnelTimeout: r.client ? r.client.tunnel_timeout : null,
    clMaxConcurrent: r.client ? r.client.max_concurrent : null,
    cacheTtlMs: r.cache ? r.cache.default_ttl : null,
  };
}
onMounted(load);

// re-sync form fields whenever fresh GET data arrives (incl. after save)
watch(data, (d) => {
  if (d) setFromRuntime();
});

// --- save / reset ------------------------------------------------------------
function collectPayload(group) {
  const num = (k) => {
    const vv = fieldValues.value[k];
    return vv == null || vv === '' ? null : Number(vv);
  };
  switch (group) {
    case 'routing':
      return { strategy: fieldValues.value.strategy };
    case 'circuit_breaker':
      return {
        error_threshold: num('cbErrorThreshold'),
        window_ms: num('cbWindowMs'),
        recovery_timeout_ms: num('cbRecoveryMs'),
        half_open_max_attempts: num('cbHalfOpen'),
      };
    case 'bandwidth': {
      const g = num('bwGlobalRateKb');
      const d = num('bwDefaultRateKb');
      return {
        enabled: !!fieldValues.value.bwEnabled,
        global_rate: g != null ? g * 1024 : 0,
        default_rate: d != null ? d * 1024 : 0,
      };
    }
    case 'client':
      return {
        request_timeout: num('clRequestTimeout'),
        tunnel_timeout: num('clTunnelTimeout'),
        max_concurrent: num('clMaxConcurrent'),
      };
    case 'cache':
      return { default_ttl: num('cacheTtlMs') };
    default:
      return null;
  }
}

function saveGroup(group) {
  const body = collectPayload(group);
  if (!body) return;
  if (Object.values(body).some((x) => x === null)) {
    message.error('请填写有效的数字');
    return;
  }
  savingGroup.value = group;
  saveSettingsGroup(group, body)
    .then((d) => {
      if (!d.success) throw new Error(d.message || '保存失败');
      message.success('已保存并即时生效');
      load();
      requestStatus().catch(() => {});
    })
    .catch((err) => message.error('保存失败: ' + err.message))
    .finally(() => {
      savingGroup.value = '';
    });
}

// reset confirm
const resetTarget = ref('');
const showResetDialog = ref(false);
const resetNames = {
  routing: '路由策略',
  circuit_breaker: '熔断器',
  bandwidth: '带宽限制',
  client: '客户端超时/并发',
  cache: '缓存 TTL',
};
function askReset(group) {
  resetTarget.value = group;
  showResetDialog.value = true;
}
function doReset() {
  const group = resetTarget.value;
  resetTarget.value = '';
  showResetDialog.value = false;
  resetSettingsGroup(group)
    .then((d) => {
      if (!d.success) throw new Error(d.message || '恢复失败');
      message.success('已恢复默认值');
      load();
      requestStatus().catch(() => {});
    })
    .catch((err) => message.error('恢复失败: ' + err.message));
}
</script>

<template>
  <div v-if="data" class="settings">
    <p class="settings-sub">
      修改<b>即时生效</b>并持久化，重启后自动恢复。「恢复默认」回到 config.yaml 的初始值。
    </p>

    <!-- Routing -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>路由策略</h3>
        <NTag size="small" :bordered="false" type="info">即时生效</NTag>
        <span v-if="!editable.routing" class="s-no-perm">无权限修改</span>
      </div>
      <div class="s-strategy-list">
        <button
          v-for="s in availStrategy"
          :key="s"
          class="s-strategy"
          :class="{ selected: fieldValues.strategy === s }"
          :disabled="!editable.routing"
          @click="fieldValues.strategy = s"
        >
          <span class="s-so-name">{{ STRATEGY_LABELS[s] || s }}</span>
          <span class="s-so-desc">{{ STRATEGY_DESC[s] || '' }}</span>
        </button>
      </div>
      <div class="s-foot">
        <NButton size="small" type="primary" :loading="savingGroup === 'routing'" :disabled="!editable.routing" @click="saveGroup('routing')">
          保存
        </NButton>
      </div>
    </div>

    <!-- Circuit breaker -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>熔断器参数</h3>
        <NTag size="small" :bordered="false" type="info">即时生效</NTag>
        <span v-if="!editable.circuit_breaker" class="s-no-perm">无权限修改</span>
      </div>
      <div class="s-grid">
        <div class="s-form">
          <label>连续失败阈值（次）</label>
          <NInputNumber v-model:value="fieldValues.cbErrorThreshold" :min="1" :disabled="!editable.circuit_breaker" style="width: 100%" />
        </div>
        <div class="s-form">
          <label>错误计数窗口（毫秒）</label>
          <NInputNumber v-model:value="fieldValues.cbWindowMs" :min="1000" :disabled="!editable.circuit_breaker" style="width: 100%" />
        </div>
        <div class="s-form">
          <label>恢复探测等待时间（毫秒）</label>
          <NInputNumber v-model:value="fieldValues.cbRecoveryMs" :min="1000" :disabled="!editable.circuit_breaker" style="width: 100%" />
        </div>
        <div class="s-form">
          <label>半开状态最大重试次数</label>
          <NInputNumber v-model:value="fieldValues.cbHalfOpen" :min="1" :disabled="!editable.circuit_breaker" style="width: 100%" />
        </div>
      </div>
      <div class="s-foot">
        <NButton size="small" :disabled="!editable.circuit_breaker" @click="askReset('circuit_breaker')">恢复默认</NButton>
        <NButton size="small" type="primary" :loading="savingGroup === 'circuit_breaker'" :disabled="!editable.circuit_breaker" @click="saveGroup('circuit_breaker')">
          保存
        </NButton>
      </div>
    </div>

    <!-- Bandwidth -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>带宽限制</h3>
        <NTag size="small" :bordered="false" type="info">即时生效</NTag>
        <span v-if="!editable.bandwidth" class="s-no-perm">无权限修改</span>
      </div>
      <div class="s-form" style="flex-direction: row; align-items: center; gap: 10px">
        <NSwitch v-model:value="fieldValues.bwEnabled" :disabled="!editable.bandwidth" />
        <span style="font-size: 13px; color: var(--np-text-2)">启用带宽限制</span>
      </div>
      <div class="s-grid">
        <div class="s-form">
          <label>全局速率上限（KB/s）</label>
          <NInputNumber v-model:value="fieldValues.bwGlobalRateKb" :min="0" :disabled="!editable.bandwidth" style="width: 100%" />
        </div>
        <div class="s-form">
          <label>单节点默认速率上限（KB/s）</label>
          <NInputNumber v-model:value="fieldValues.bwDefaultRateKb" :min="0" :disabled="!editable.bandwidth" style="width: 100%" />
        </div>
      </div>
      <div class="s-foot">
        <NButton size="small" :disabled="!editable.bandwidth" @click="askReset('bandwidth')">恢复默认</NButton>
        <NButton size="small" type="primary" :loading="savingGroup === 'bandwidth'" :disabled="!editable.bandwidth" @click="saveGroup('bandwidth')">
          保存
        </NButton>
      </div>
    </div>

    <!-- Client params -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>客户端超时 / 并发</h3>
        <NTag size="small" :bordered="false" type="info">即时生效</NTag>
        <span v-if="!editable.client" class="s-no-perm">无权限修改</span>
      </div>
      <div class="s-grid">
        <div class="s-form">
          <label>请求超时（毫秒）</label>
          <NInputNumber v-model:value="fieldValues.clRequestTimeout" :min="1" :disabled="!editable.client" style="width: 100%" />
        </div>
        <div class="s-form">
          <label>隧道超时（毫秒）</label>
          <NInputNumber v-model:value="fieldValues.clTunnelTimeout" :min="1" :disabled="!editable.client" style="width: 100%" />
        </div>
        <div class="s-form">
          <label>单节点最大并发数</label>
          <NInputNumber v-model:value="fieldValues.clMaxConcurrent" :min="1" :disabled="!editable.client" style="width: 100%" />
        </div>
      </div>
      <div class="s-foot">
        <NButton size="small" :disabled="!editable.client" @click="askReset('client')">恢复默认</NButton>
        <NButton size="small" type="primary" :loading="savingGroup === 'client'" :disabled="!editable.client" @click="saveGroup('client')">
          保存
        </NButton>
      </div>
    </div>

    <!-- Cache -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>缓存 TTL</h3>
        <NTag size="small" :bordered="false" type="info">即时生效</NTag>
        <span v-if="!editable.cache" class="s-no-perm">无权限修改</span>
      </div>
      <div class="s-grid">
        <div class="s-form">
          <label>默认缓存时长（毫秒）</label>
          <NInputNumber v-model:value="fieldValues.cacheTtlMs" :min="0" :disabled="!editable.cache" style="width: 100%" />
        </div>
      </div>
      <div class="s-foot">
        <NButton size="small" :disabled="!editable.cache" @click="askReset('cache')">恢复默认</NButton>
        <NButton size="small" type="primary" :loading="savingGroup === 'cache'" :disabled="!editable.cache" @click="saveGroup('cache')">
          保存
        </NButton>
      </div>
    </div>

    <!-- Restart-only read-only -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>只读信息（重启后生效）</h3>
        <NTag size="small" :bordered="false" type="warning">仅显示</NTag>
      </div>
      <div class="s-ro-grid">
        <div class="s-ro-item"><span>Web 端口</span><b>{{ (restartOnly.server && restartOnly.server.web_port) ?? '-' }}</b></div>
        <div class="s-ro-item"><span>HTTP 代理端口</span><b>{{ (restartOnly.server && restartOnly.server.http_proxy_port) ?? '-' }}</b></div>
        <div class="s-ro-item"><span>SOCKS5 端口</span><b>{{ (restartOnly.server && restartOnly.server.socks5_port) ?? '-' }}</b></div>
        <div class="s-ro-item"><span>Web 登录用户</span><b>{{ (restartOnly.auth && restartOnly.auth.web_username) || '-' }}</b></div>
        <div class="s-ro-item"><span>日志级别</span><b>{{ restartOnly.logging_level || '-' }}</b></div>
        <div class="s-ro-item">
          <span>节点认证 Token</span>
          <b :class="restartOnly.auth && restartOnly.auth.token_configured ? 'ro-ok' : 'ro-warn'">
            {{ restartOnly.auth && restartOnly.auth.token_configured ? '已设置为非默认值' : '仍为默认值 node-proxy-default-token' }}
          </b>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model:show="showResetDialog"
      title="恢复默认设置"
      :message="'确定将该组（' + (resetNames[resetTarget] || resetTarget) + '）恢复为 config.yaml 默认值？'"
      :danger="false"
      ok-text="恢复默认"
      @ok="doReset"
    />
  </div>
  <div v-else class="s-loading">
    {{ loading ? '加载中...' : '设置数据加载失败' }}
    <NButton v-if="!loading" size="small" @click="load()">重试</NButton>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 14px; max-width: 980px; }
.settings-sub { color: var(--np-text-muted); font-size: 13px; margin: 0 0 2px; }
.settings-sub b { color: var(--np-text-2); }
.s-group {
  background: var(--np-bg-soft);
  border: 1px solid var(--np-border-soft);
  border-radius: 12px;
  padding: 16px 18px;
}
.s-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.s-group-head h3 { margin: 0; font-size: 14px; }
.s-no-perm { font-size: 12px; color: var(--np-danger); }
.s-strategy-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.s-strategy {
  text-align: left;
  border: 1px solid var(--np-border);
  border-radius: 10px;
  background: var(--np-bg);
  padding: 12px 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--np-text);
}
.s-strategy:hover:not(:disabled) { border-color: var(--np-primary); }
.s-strategy.selected {
  border-color: var(--np-primary);
  background: var(--np-primary);
  color: #fff;
}
.s-strategy.selected .s-so-desc { color: rgba(255, 255, 255, 0.85); }
.s-strategy:disabled { cursor: not-allowed; opacity: 0.55; }
.s-so-name { font-weight: 600; font-size: 13.5px; }
.s-so-desc { font-size: 11.5px; color: var(--np-text-muted); }
.s-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}
.s-form {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 6px;
}
.s-form label { font-size: 12.5px; color: var(--np-text-2); }
.s-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.s-ro-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}
.s-ro-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  background: var(--np-bg);
  border: 1px solid var(--np-border-soft);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--np-text-muted);
}
.s-ro-item b { color: var(--np-text); font-weight: 600; }
.s-ro-item .ro-ok { color: var(--np-success); }
.s-ro-item .ro-warn { color: var(--np-danger); }
.s-loading {
  text-align: center;
  color: var(--np-text-muted);
  padding: 60px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
</style>
