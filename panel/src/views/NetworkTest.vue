<script setup>
import { computed, h, ref } from 'vue';
import { NButton, NCard, NCheckbox, NCheckboxGroup, NCollapse, NCollapseItem, NDataTable, NInput, NInputNumber, NProgress, NSelect, NSpace, NTag, NText, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import { startNetworkTest, getNetworkTestTask, fetchNetworkTestTypes } from '../api';
import { store } from '../store';

const message = useMessage();

// State
const types = ref([]);
const selectedType = ref('ping');
const targetsText = ref('');
const allNodes = ref(true);          // test from every online node
const clientIds = ref([]);           // manual selection when allNodes is off
const options = ref({
  port: 80,
  timeout: 3000,
  count: 3,
  method: 'GET',
  protocol: '1.1',
  redirects: 0,
  referer: '',
  userAgent: '',
  body: '',
  recordTypes: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'],
});
const running = ref(false);
const taskId = ref(null);
const results = ref([]);
const progress = ref(0);
const total = ref(0);
const done = ref(0);
const taskState = ref('');
const pollTimer = ref(null);

const onlineClients = computed(() => (store.status ? store.status.clients || [] : []));
const clientOptions = computed(() =>
  onlineClients.value.map((c) => ({
    label: (c.info && c.info.hostname) || c.id,
    value: c.id,
  }))
);

fetchNetworkTestTypes().then((d) => { types.value = d.types || []; }).catch(() => {});

// Pick every online node
function pickAll() {
  clientIds.value = onlineClients.value.map((c) => c.id);
}

async function startTest() {
  const targets = targetsText.value.split('\n').map((t) => t.trim()).filter(Boolean);
  if (!targets.length) return message.warning('请输入至少一个目标');
  if (targets.length > 256) return message.warning('目标数量不能超过 256 个');
  if (!selectedType.value) return message.warning('请选择测试类型');
  if (!allNodes.value && !clientIds.value.length) return message.warning('请至少选择一个执行节点，或勾选「全部节点」');

  running.value = true;
  results.value = [];
  progress.value = 0;
  total.value = 0;
  done.value = 0;
  taskState.value = '';

  try {
    const clients = allNodes.value ? 'all' : clientIds.value;
    const data = await startNetworkTest(selectedType.value, targets, prepareOptions(), clients);
    taskId.value = data.taskId;
    pollTask();
  } catch (err) {
    message.error('启动测试失败: ' + err.message);
    running.value = false;
  }
}

function prepareOptions() {
  const o = {};
  if (selectedType.value === 'ping') {
    o.count = options.value.count;
    o.timeout = options.value.timeout;
  } else if (selectedType.value === 'tcping') {
    o.port = options.value.port;
    o.timeout = options.value.timeout;
  } else if (selectedType.value === 'http') {
    o.method = options.value.method;
    o.protocol = options.value.protocol;
    o.redirects = options.value.redirects;
    o.timeout = options.value.timeout;
    if (options.value.referer) o.referer = options.value.referer;
    if (options.value.userAgent) o.userAgent = options.value.userAgent;
    if (options.value.method === 'POST' && options.value.body) o.body = options.value.body;
  } else if (selectedType.value === 'dns') {
    o.recordTypes = options.value.recordTypes;
  } else if (selectedType.value === 'traceroute') {
    o.timeout = options.value.timeout;
  }
  return o;
}

async function pollTask() {
  if (!taskId.value) return;
  try {
    const task = await getNetworkTestTask(taskId.value);
    results.value = task.results || [];
    total.value = task.total || 0;
    done.value = task.done || 0;
    taskState.value = task.state || '';
    progress.value = total.value > 0 ? Math.round((done.value / total.value) * 100) : 0;

    if (task.state === 'done' || task.state === 'error') {
      running.value = false;
      if (task.state === 'error') message.error('测试出错: ' + (task.error || ''));
      return;
    }
    pollTimer.value = setTimeout(pollTask, 500);
  } catch (err) {
    running.value = false;
    message.error('获取结果失败: ' + err.message);
  }
}

function clearResults() {
  results.value = [];
  progress.value = 0;
  total.value = 0;
  done.value = 0;
  taskState.value = '';
  taskId.value = null;
  if (pollTimer.value) clearTimeout(pollTimer.value);
  running.value = false;
}

// node x target table: stable sort by node then target index
const sorted = computed(() =>
  [...results.value].sort((a, b) =>
    (a.clientId === b.clientId ? a.index - b.index : (a.clientId < b.clientId ? -1 : 1)))
);

function exportCSV() {
  const rows = sorted.value.map((r) => [
    r.clientLabel || r.clientId, r.index + 1, r.target, r.ok ? '成功' : '失败', r.ms || '', (r.error || '').replace(/"/g, '""'),
    (r.detail || '').replace(/"/g, '""'),
  ]);
  const csv = ['节点,序号,目标,状态,耗时(ms),错误,详情']
    .concat(rows.map((r) => r.map((v) => (String(v).includes(',') ? '"' + v + '"' : v)).join(',')))
    .join('\n');
  download(csv, '网络测试结果.csv', 'text/csv;charset=utf-8');
}

function exportJSON() {
  const json = JSON.stringify({ type: selectedType.value, mode: allNodes.value ? 'all-nodes' : clientIds.value, results: sorted.value }, null, 2);
  download(json, '网络测试结果.json', 'application/json');
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Table columns: node x target
const columns = computed(() => [
  { key: 'client', title: '节点', width: 150, ellipsis: { tooltip: true },
    render: (row) => row.clientLabel || row.clientId },
  { key: 'seq', title: '#', width: 45, render: (row) => row.index + 1 },
  { key: 'target', title: '目标', width: 190, ellipsis: { tooltip: true } },
  {
    key: 'status', title: '状态', width: 75,
    render: (row) => h(NTag, { type: row.ok ? 'success' : 'error', size: 'small' },
      { default: () => row.ok ? '成功' : '失败' }),
  },
  { key: 'ms', title: '耗时(ms)', width: 95, render: (row) => row.ms != null ? String(row.ms) : '-' },
  { key: 'detail', title: '详情', ellipsis: { tooltip: true },
    render: (row) => (row.error && !row.ok ? row.error : (row.detail || '')) },
]);

// Type-specific options visibility
const isPing = computed(() => selectedType.value === 'ping');
const isTcping = computed(() => selectedType.value === 'tcping');
const isHttp = computed(() => selectedType.value === 'http');
const isDns = computed(() => selectedType.value === 'dns');
const isTraceroute = computed(() => selectedType.value === 'traceroute');
</script>

<template>
  <div class="network-test">
    <section class="nt-hero np-panel">
      <span class="nt-hero-icon"><AppIcon name="radar" :size="20" /></span>
      <div class="nt-hero-copy">
        <div class="nt-eyebrow">NETWORK TOOLKIT</div>
        <h2>网络测试</h2>
        <p>从服务端或任意在线节点发起 Ping / TCPing / HTTP / DNS / 路由追踪</p>
      </div>
      <span class="nt-hero-badge">
        <i class="np-dot" :class="onlineClients.length ? 'alive' : 'idle'"></i>
        {{ onlineClients.length }} 个节点在线
      </span>
    </section>

    <NCard title="测试配置" size="small" class="nt-card">
      <NSpace vertical>
        <!-- Type selector -->
        <div class="nt-row">
          <NSelect
            v-model:value="selectedType"
            :options="types.map((t) => ({ label: t.label, value: t.id }))"
            placeholder="选择测试类型"
            style="width: 200px"
            :disabled="running"
          />
          <NText depth="3" style="margin-left: 8px; font-size: 12px;">
            在线节点：{{ onlineClients.length }} 个 · 目标：{{ targetsText.split('\n').filter(Boolean).length }} / 256
          </NText>
        </div>

        <!-- Executor nodes -->
        <div class="nt-row">
          <NCheckbox v-model:checked="allNodes" :disabled="running">全部在线节点执行</NCheckbox>
          <template v-if="!allNodes">
            <NSelect
              v-model:value="clientIds"
              multiple
              :options="clientOptions"
              placeholder="选择执行节点"
              style="width: 420px"
              :disabled="running"
              :max-tag-count="3"
            />
            <NButton size="small" :disabled="running" @click="pickAll">选全部</NButton>
          </template>
        </div>

        <!-- Targets -->
        <NInput
          v-model:value="targetsText"
          type="textarea"
          placeholder="输入目标，每行一个&#10;例如：&#10;example.com&#10;1.1.1.1:443&#10;http://example.com/pub"
          :rows="4"
          :disabled="running"
        />

        <!-- Options (collapsible) -->
        <NCollapse>
          <NCollapseItem title="高级选项" name="opts">
            <NSpace vertical>
              <div v-if="isPing || isTcping || isHttp || isTraceroute" class="nt-row">
                <div v-if="isPing">
                  <NInputNumber v-model:value="options.count" :min="1" :max="10" size="small" style="width: 80px" />
                  <span style="margin-left: 6px; font-size: 12px;">次数</span>
                </div>
                <NInputNumber v-model:value="options.timeout" :min="500" :step="500" size="small" style="width: 80px" />
                <span style="margin-left: 6px; font-size: 12px;">超时 (ms)</span>
                <NInputNumber v-if="isTcping" v-model:value="options.port" :min="1" :max="65535" size="small" style="width: 80px" />
                <span v-if="isTcping" style="margin-left: 6px; font-size: 12px;">端口</span>
              </div>

              <div v-if="isHttp" class="nt-row">
                <NSelect v-model:value="options.method" :options="[{label:'GET',value:'GET'},{label:'POST',value:'POST'}]" size="small" style="width: 90px" />
                <NSelect v-model:value="options.protocol" :options="[{label:'HTTP/1.1',value:'1.1'},{label:'HTTP/2',value:'2'},{label:'HTTP/3',value:'3'}]" size="small" style="width: 120px" />
                <NInputNumber v-model:value="options.redirects" :min="0" :max="10" size="small" style="width: 70px" />
                <span style="font-size: 12px;">最大重定向</span>
              </div>

              <div v-if="isHttp" class="nt-row">
                <NInput v-model:value="options.referer" placeholder="Referer（可选）" size="small" style="width: 200px" />
                <NInput v-model:value="options.userAgent" placeholder="User-Agent（可选）" size="small" style="width: 250px" />
              </div>

              <div v-if="isHttp && options.method === 'POST'" class="nt-row">
                <NInput v-model:value="options.body" type="textarea" placeholder="POST 请求体（可选）" :rows="2" size="small" style="width: 100%" />
              </div>

              <div v-if="isDns">
                <NCheckboxGroup v-model:value="options.recordTypes">
                  <NSpace>
                    <NCheckbox value="A" label="A" />
                    <NCheckbox value="AAAA" label="AAAA" />
                    <NCheckbox value="CNAME" label="CNAME" />
                    <NCheckbox value="MX" label="MX" />
                    <NCheckbox value="TXT" label="TXT" />
                    <NCheckbox value="NS" label="NS" />
                  </NSpace>
                </NCheckboxGroup>
              </div>
            </NSpace>
          </NCollapseItem>
        </NCollapse>

        <!-- Actions -->
        <NSpace>
          <NButton type="primary" :loading="running" @click="startTest" :disabled="running || !onlineClients.length">
            {{ !onlineClients.length ? '无在线节点' : running ? '测试中...' : '开始测试' }}
          </NButton>
          <NButton @click="clearResults" :disabled="running && !results.length">清空</NButton>
          <NButton v-if="results.length && !running" @click="exportCSV">导出 CSV</NButton>
          <NButton v-if="results.length && !running" @click="exportJSON">导出 JSON</NButton>
        </NSpace>
      </NSpace>
    </NCard>

    <!-- Progress -->
    <NCard v-if="running || results.length" size="small" style="margin-top: 12px;">
      <NProgress v-if="running" type="line" :percentage="progress" :indicator-placement="'inside'" />
      <NText depth="3" style="font-size: 12px;">
        已完成 {{ done }}/{{ total }} 项{{ taskState === 'error' ? ' — 出错' : '' }}
      </NText>
    </NCard>

    <!-- Results table (node x target) -->
    <NCard v-if="results.length" size="small" style="margin-top: 12px;">
      <NDataTable
        :columns="columns"
        :data="sorted"
        :max-height="500"
        :striped="true"
        :bordered="true"
        :single-line="false"
        size="small"
      />
    </NCard>
  </div>
</template>

<style scoped>
.network-test {
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.nt-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  background:
    radial-gradient(420px 150px at 0% 0%, rgba(var(--np-violet-rgb), 0.14), transparent 70%),
    var(--np-panel-bg);
}
.nt-hero-icon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--np-violet);
  background: rgba(var(--np-violet-rgb), 0.1);
  border: 1px solid rgba(var(--np-violet-rgb), 0.18);
}
.nt-hero-copy { min-width: 0; flex: 1; }
.nt-eyebrow {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--np-text-muted);
}
.nt-hero h2 {
  margin: 4px 0 3px;
  font-size: 19px;
  letter-spacing: -0.02em;
}
.nt-hero p {
  margin: 0;
  font-size: 12px;
  color: var(--np-text-muted);
}
.nt-hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--np-text-2);
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--np-border-soft);
}
.nt-card :deep(.n-card-header) {
  border-bottom: 1px solid var(--np-border-soft);
  padding-bottom: 12px;
  margin-bottom: 14px;
}
.nt-card :deep(.n-card__content) {
  padding-top: 0;
}
.nt-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 700px) {
  .nt-hero { flex-wrap: wrap; padding: 16px; }
  .nt-hero-copy { flex-basis: calc(100% - 60px); }
}
</style>