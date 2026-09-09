<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NInput, NInputNumber, NSelect, NSwitch, NTag, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { fetchSettings, saveSettingsGroup, resetSettingsGroup } from '../api';
import {
  fetchProxyPasswords,
  createProxyPassword,
  updateProxyPassword,
  deleteProxyPassword,
  regenerateProxyPassword,
} from '../api';
import { requestStatus, store } from '../store';

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
  requestStatus().catch(() => {});
  refreshPasswords();
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
    clTunnelIdleTimeout: r.client ? r.client.tunnel_idle_timeout : null,
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
        tunnel_idle_timeout: num('clTunnelIdleTimeout'),
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

// ===========================================================================
// Multi proxy passwords (issue #53)
// ===========================================================================
const pwLoading = ref(false);
const pwDenied = ref(false);
const pwRows = ref([]); // entries + a derived mode/target for the selects
const pwDefaultUser = ref('');

const STRATEGY_OPTIONS = Object.keys(STRATEGY_LABELS).map((s) => ({
  label: STRATEGY_LABELS[s],
  value: s,
}));

// Routing options: default pool, tag/group pools, or a specific node UUID.
const pwRouteOptions = computed(() => {
  const out = [{ label: '默认池（全局路由策略）', value: 'none' }];
  const seenTags = new Set();
  const seenGroups = new Set();
  const nodes = (store.status && store.status.clients) || [];
  for (const c of nodes) {
    for (const t of c.tags || []) {
      if (t && !seenTags.has(t)) {
        seenTags.add(t);
        out.push({ label: '标签：' + t, value: 'tag:' + t });
      }
    }
    if (c.group && !seenGroups.has(c.group)) {
      seenGroups.add(c.group);
      out.push({ label: '分组：' + c.group, value: 'tag:' + c.group });
    }
  }
  for (const c of nodes) {
    const label = c.alias || (c.info && c.info.hostname) || c.id;
    out.push({
      label: '节点：' + label + (c.alias || (c.info && c.info.hostname) ? ' (' + c.id.substring(0, 8) + '…)' : ''),
      value: 'node:' + c.id,
    });
  }
  return out;
});

function rowToMode(row) {
  if (row.clientId) return { mode: 'node', target: 'node:' + row.clientId };
  if (row.tag) return { mode: 'tag', target: 'tag:' + row.tag };
  return { mode: 'none', target: 'none' };
}

function refreshPasswords() {
  pwLoading.value = true;
  fetchProxyPasswords()
    .then((d) => {
      pwDenied.value = false;
      pwDefaultUser.value = (d.defaultPool && d.defaultPool.username) || '';
      pwRows.value = (d.passwords || []).map((e) => {
        const m = rowToMode(e);
        return { ...e, _mode: m.mode, _target: m.target };
      });
    })
    .catch((err) => {
      pwDenied.value = true;
      if (err.message && err.message.indexOf('Permission') === -1) {
        message.error('加载代理密码失败: ' + err.message);
      }
    })
    .finally(() => {
      pwLoading.value = false;
    });
}

// Add-password form
const addOpen = ref(false);
const addForm = ref({ label: '', strategy: null, _target: 'none', enabled: true });
function addRow() {
  addOpen.value = true;
  addForm.value = { label: '', strategy: null, _target: 'none', enabled: true };
}
function createRow() {
  const f = addForm.value;
  const payload = { label: f.label.trim(), strategy: f.strategy, enabled: f.enabled !== false };
  if (String(f._target).startsWith('tag:')) payload.tag = String(f._target).slice(4);
  else if (String(f._target).startsWith('node:')) payload.clientId = String(f._target).slice(5);
  createProxyPassword(payload)
    .then((d) => {
      if (!d.success) throw new Error(d.message || '创建失败');
      message.success('已创建（新密码自动生成）');
      addOpen.value = false;
      refreshPasswords();
      requestStatus().catch(() => {});
    })
    .catch((err) => message.error('创建失败: ' + err.message));
}

function commitRow(row, patch) {
  updateProxyPassword(row.id, patch)
    .then((d) => {
      if (!d.success) throw new Error(d.message || '更新失败');
      refreshPasswords();
    })
    .catch((err) => message.error('更新失败: ' + err.message));
}

function onChangeTarget(row, value) {
  row._target = value;
  const patch = { tag: null, clientId: null };
  if (String(value).startsWith('tag:')) patch.tag = String(value).slice(4);
  else if (String(value).startsWith('node:')) patch.clientId = String(value).slice(5);
  commitRow(row, patch);
}
function onChangeStrategy(row, value) {
  row.strategy = value;
  commitRow(row, { strategy: value });
}
function onToggleEnabled(row, checked) {
  row.enabled = checked;
  commitRow(row, { enabled: checked });
}

function copyPassword(text) {
  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(text)
      .then(() => message.success('已复制'))
      .catch(() => message.error('复制失败'));
  }
}

function regenRow(row) {
  regenerateProxyPassword(row.id)
    .then((d) => {
      if (!d.success) throw new Error(d.message || '重新生成失败');
      message.success('已生成新密码');
      refreshPasswords();
    })
    .catch((err) => message.error('重新生成失败: ' + err.message));
}

const pwDeleteTarget = ref(null);
const pwDeleteVisible = ref(false);
function askDeleteRow(row) {
  pwDeleteTarget.value = row;
  pwDeleteVisible.value = true;
}
function doDeleteRow() {
  const row = pwDeleteTarget.value;
  pwDeleteVisible.value = false;
  pwDeleteTarget.value = null;
  if (!row) return;
  deleteProxyPassword(row.id)
    .then((d) => {
      if (!d.success) throw new Error(d.message || '删除失败');
      message.success('已删除');
      refreshPasswords();
    })
    .catch((err) => message.error('删除失败: ' + err.message));
}

const pwUsage = computed(() => {
  if (!pwDefaultUser.value) return '';
  return 'HTTP: curl -x http://任意用户名:<密码>@服务器:8080 https://目标/  |  SOCKS5: curl -x socks5h://任意用户名:<密码>@服务器:1080 https://目标/';
});
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
          <label title="隧道无双向流量超过该时长即被关闭（0 = 关闭回收）">隧道空闲回收（毫秒，0=关）</label>
          <NInputNumber v-model:value="fieldValues.clTunnelIdleTimeout" :min="0" :disabled="!editable.client" style="width: 100%" />
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

    <!-- Proxy passwords (multi-password routing, issue #53) -->
    <div class="s-group">
      <div class="s-group-head">
        <h3>代理密码（分流）</h3>
        <NTag size="small" :bordered="false" type="info">即时生效</NTag>
      </div>

      <div v-if="pwDenied" class="s-no-perm">无权限查看或管理代理密码</div>

      <template v-else>
        <p class="pw-hint">额外密码只校验密码本身（用户名可任意）。可将流量分流到标签/分组节点池（池内用所选策略），或直接指定某节点。</p>

        <div v-if="!addOpen" class="pw-toolbar">
          <NButton size="small" type="primary" @click="addRow">+ 生成新密码</NButton>
        </div>
        <div v-else class="pw-add">
          <div class="s-form pw-add-field">
            <label>备注</label>
            <NInput v-model:value="addForm.label" placeholder="如：爬虫A" style="width: 150px" />
          </div>
          <div class="s-form pw-add-field">
            <label>分流目标</label>
            <NSelect v-model:value="addForm._target" :options="pwRouteOptions" filterable style="width: 230px" />
          </div>
          <div class="s-form pw-add-field">
            <label>路由策略</label>
            <NSelect v-model:value="addForm.strategy" :options="STRATEGY_OPTIONS" clearable placeholder="默认（全局）" style="width: 170px" />
          </div>
          <div class="pw-add-btns">
            <NButton size="small" type="primary" @click="createRow">创建</NButton>
            <NButton size="small" @click="addOpen = false">取消</NButton>
          </div>
        </div>

        <div v-if="pwLoading" class="s-loading" style="padding: 24px 0">加载中...</div>
        <div v-else-if="!pwRows.length" class="pw-empty">暂无额外代理密码。生成一个后即可用它把流量分流到指定标签/分组或强制走某个节点。</div>

        <div v-for="row in pwRows" :key="row.id" class="pw-row">
          <NInput v-model:value="row.label" size="small" placeholder="备注" style="width: 150px"
            @change="(v) => commitRow(row, { label: String(v || '').trim() })" />
          <div class="pw-pass">
            <NInput :value="row.password" size="small" readonly style="width: 240px" />
            <NButton size="small" @click="copyPassword(row.password)">复制</NButton>
            <NButton size="small" @click="regenRow(row)">重新生成</NButton>
          </div>
          <NSelect :value="row._target" :options="pwRouteOptions" filterable size="small" style="width: 220px"
            @update:value="(v) => onChangeTarget(row, v)" />
          <NSelect :value="row.strategy" :options="STRATEGY_OPTIONS" clearable placeholder="策略默认" size="small" style="width: 140px"
            @update:value="(v) => onChangeStrategy(row, v)" />
          <div class="pw-ops">
            <NSwitch :value="row.enabled" size="small" @update:value="(c) => onToggleEnabled(row, c)" />
            <span class="pw-enable-text">{{ row.enabled ? '启用' : '停用' }}</span>
            <NButton size="small" type="error" ghost @click="askDeleteRow(row)">删除</NButton>
          </div>
        </div>
      </template>
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
    <ConfirmDialog
      v-model:show="pwDeleteVisible"
      title="删除代理密码"
      :message="pwDeleteTarget ? '确定删除该代理密码（' + (pwDeleteTarget.label || '未命名') + '）？使用它的客户端将立即无法认证。' : ''"
      :danger="true"
      ok-text="删除"
      @ok="doDeleteRow"
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

/* Proxy passwords (issue #53) */
.pw-hint {
  font-size: 12.5px;
  color: var(--np-text-muted);
  margin: 0 0 12px;
}
.pw-toolbar { margin-bottom: 10px; }
.pw-add {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  background: var(--np-bg);
  border: 1px solid var(--np-border-soft);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.pw-add-field { margin-bottom: 0; }
.pw-add-btns { display: flex; gap: 8px; padding-bottom: 2px; }
.pw-empty {
  font-size: 13px;
  color: var(--np-text-muted);
  background: var(--np-bg);
  border: 1px dashed var(--np-border-soft);
  border-radius: 10px;
  padding: 18px 14px;
  text-align: center;
}
.pw-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  background: var(--np-bg);
  border: 1px solid var(--np-border-soft);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.pw-pass { display: flex; align-items: center; gap: 6px; }
.pw-pass .n-input { font-family: 'Fira Code', Consolas, monospace; font-size: 12px; }
.pw-ops { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.pw-enable-text { font-size: 12px; color: var(--np-text-muted); }

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
