<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NCheckbox, NInput, NModal, NPopover, NSelect, NDataTable, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import { store, requestStatus } from '../store';
import { kickClient, saveClientMeta } from '../api';
import { formatBytes, formatDuration } from '../utils';

const message = useMessage();

// ---------------------------------------------------------------------------
// Column model (same 17 columns as before; visibility is user-configurable)
// ---------------------------------------------------------------------------
const ALL_COLUMNS = [
  { key: 'status', label: '状态', width: 60 },
  { key: 'id', label: '节点 ID', width: 130 },
  { key: 'host', label: '主机名', width: 150 },
  { key: 'ip', label: 'IP 地址', width: 150 },
  { key: 'platform', label: '系统 / 平台', width: 140 },
  { key: 'region', label: '区域', width: 110 },
  { key: 'group', label: '分组', width: 110 },
  { key: 'tags', label: '标签', width: 160 },
  { key: 'notes', label: '备注', width: 170 },
  { key: 'req', label: '请求', width: 70 },
  { key: 'tunnel', label: '隧道', width: 70 },
  { key: 'traffic', label: '流量', width: 100 },
  { key: 'ms', label: '响应(ms)', width: 90 },
  { key: 'cb', label: '熔断器', width: 100 },
  { key: 'conn', label: '连接时间', width: 110 },
  { key: 'active', label: '最后活跃', width: 110 },
  { key: 'ops', label: '操作', width: 110, sticky: true },
];
const COL_STORAGE = 'np_visible_cols';

function loadVisibleKeys() {
  try {
    const raw = localStorage.getItem(COL_STORAGE);
    if (raw) {
      const keys = JSON.parse(raw);
      if (Array.isArray(keys) && keys.length > 0) {
        return ALL_COLUMNS.filter((c) => keys.includes(c.key)).map((c) => c.key);
      }
    }
  } catch (_) {}
  return ALL_COLUMNS.map((c) => c.key);
}

const visibleKeys = ref(loadVisibleKeys());
const visibleCount = computed(() => visibleKeys.value.length);

function saveVisible() {
  localStorage.setItem(COL_STORAGE, JSON.stringify(visibleKeys.value));
}
function toggleCol(key) {
  visibleKeys.value = visibleKeys.value.includes(key)
    ? visibleKeys.value.filter((k) => k !== key)
    : [...visibleKeys.value, key];
  saveVisible();
}
function showAllCols() {
  visibleKeys.value = ALL_COLUMNS.map((c) => c.key);
  saveVisible();
}

// ---------------------------------------------------------------------------
// Row source
// ---------------------------------------------------------------------------
const clients = computed(() => (store.status ? store.status.clients || [] : []));
const loading = computed(() => !store.status);

const search = ref('');
const groupFilter = ref(null);
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = clients.value;
  if (groupFilter.value) {
    const g = String(groupFilter.value).toLowerCase();
    list = list.filter((c) => (c.group || '').toLowerCase() === g);
  }
  if (!q) return list;
  return list.filter((c) => {
    const info = c.info || {};
    return (
      c.id.toLowerCase().includes(q) ||
      (c.group || '').toLowerCase().includes(q) ||
      (info.hostname || '').toLowerCase().includes(q) ||
      (info.ip || '').toLowerCase().includes(q) ||
      (info.platform || '').toLowerCase().includes(q) ||
      (info.region || '').toLowerCase().includes(q)
    );
  });
});

const groupOptions = computed(() => {
  const seen = new Set();
  const out = [];
  for (const c of clients.value) {
    const g = c.group;
    if (g && !seen.has(g)) {
      seen.add(g);
      out.push({ label: g, value: g });
    }
  }
  return out;
});

// Suggest existing explicit tags for the multiselect; new tags can be typed in.
const tagOptions = computed(() => {
  const seen = new Set();
  const out = [];
  for (const c of clients.value) {
    for (const t of c.tags || []) {
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push({ label: t, value: t });
      }
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// Row context helpers
// ---------------------------------------------------------------------------
function rowCtx(row) {
  const now = Date.now();
  const info = row.info || {};
  const lastSeenAgo = now - row.lastSeen;
  const connectedAgo = now - row.connectedAt;
  const isAlive = lastSeenAgo < 30000;
  const isStale = lastSeenAgo >= 30000 && lastSeenAgo < 120000;
  const dot = isAlive ? 'alive' : isStale ? 'stale' : 'dead';
  const cs = row.clientStats || {};
  const cbState = (row.circuitBreaker || { state: 'closed' }).state;
  return {
    info,
    lastSeenAgo,
    connectedAgo,
    dot,
    trafficUp: cs.bytesSent || 0,
    trafficDown: cs.bytesReceived || 0,
    cbState,
  };
}

function openEdit(row, field) {
  editClient.value = row;
  editTags.value = row.tags ? [...row.tags] : [];
  editGroup.value = row.group || '';
  editNotes.value = row.notes || '';
  editRegion.value = row.region || (row.info && row.info.region) || '';
  editFocus.value = field || null;
  editOpen.value = true;
  disarmKick();
}

// ---------------------------------------------------------------------------
// Table columns (rendered for the currently visible keys)
// ---------------------------------------------------------------------------
const clickable = (row, field, cls) => ({
  class: [cls, 'cell-edit'],
  style: { cursor: 'pointer' },
  title: '点击编辑' + (field === 'tags' ? '标签' : field === 'group' ? '分组' : field === 'notes' ? '备注' : '区域'),
  onClick: () => openEdit(row, field),
});

const tableColumns = computed(() =>
  ALL_COLUMNS.filter((c) => visibleKeys.value.includes(c.key)).map((c) => {
    const def = {
      key: c.key,
      title: c.label,
      width: c.width,
      ellipsis: { tooltip: true },
      fixed: c.sticky ? 'right' : undefined,
    };
    def.render = (row) => {
      const ctx = rowCtx(row);
      switch (c.key) {
        case 'status':
          return h('span', { class: 'np-dot ' + ctx.dot });
        case 'id':
          return h('span', { style: 'font-family: Fira Code, Consolas, monospace; font-size:12px; color: var(--np-text-muted)' },
            row.id.length > 8 ? row.id.substring(0, 8) + '…' : row.id);
        case 'host':
          return ctx.info.hostname || '-';
        case 'ip':
          return ctx.info.ip || ctx.info.localIp || '-';
        case 'platform':
          return (ctx.info.platform || '-') + (ctx.info.arch ? ' (' + ctx.info.arch + ')' : '');
        case 'region':
          return h('span', clickable(row, 'region', row.region ? 'np-region-ov' : ''), row.region || ctx.info.region || '-');
        case 'group': {
          if (!row.group)
            return h('span', clickable(row, 'group', ''), h('span', { style: 'color: var(--np-text-muted)' }, '-'));
          return h('span', clickable(row, 'group', ''), h('span', { class: 'np-group-chip' }, row.group));
        }
        case 'tags': {
          const tags = row.tags || [];
          if (!tags.length)
            return h('span', clickable(row, 'tags', ''), h('span', { style: 'color: var(--np-text-muted)' }, '-'));
          return h('span', clickable(row, 'tags', ''), tags.map((t) => h('span', { class: 'np-tag-chip' }, t)));
        }
        case 'notes':
          return h('span', clickable(row, 'notes', ''), row.notes || h('span', { style: 'color: var(--np-text-muted)' }, '-'));
        case 'req':
          return row.pendingRequestsCount;
        case 'tunnel':
          return row.pendingTunnelsCount;
        case 'traffic':
          return h('span', {
            style: 'font-variant-numeric: tabular-nums',
            title: '本次会话 — 上行 ' + formatBytes(ctx.trafficUp) + ' / 下行 ' + formatBytes(ctx.trafficDown),
          }, formatBytes(ctx.trafficUp + ctx.trafficDown));
        case 'ms':
          // Only HTTP plaintext requests are timed; HTTPS goes via CONNECT
          // tunnels which have no request/response boundary (see /logs).
          return h(
            'span',
            {
              title: 'HTTP 请求平均响应时间。HTTPS 目标走 CONNECT 隧道，不统计在此列；隧道访问记录见「请求日志」页',
            },
            row.avgResponseTime || '-'
          );
        case 'cb':
          return h('span', { class: 'np-cb ' + ctx.cbState },
            ctx.cbState === 'open' ? '熔断' : ctx.cbState === 'half_open' ? '测试' : '正常');
        case 'conn':
          return h('span', { title: new Date(row.connectedAt).toLocaleString() }, formatDuration(ctx.connectedAgo));
        case 'active':
          return h('span', { title: new Date(row.lastSeen).toLocaleString() }, formatDuration(ctx.lastSeenAgo));
        case 'ops':
          return h(
            NButton,
            { size: 'small', onClick: () => openEdit(row, null) },
            {
              default: () => [
                h(AppIcon, { name: 'edit', size: 14, style: 'margin-right: 4px' }),
                '编辑',
              ],
            }
          );
        default:
          return '';
      }
    };
    return def;
  })
);

// ---------------------------------------------------------------------------
// Edit node modal (metadata + two-step kick)
// ---------------------------------------------------------------------------
const editOpen = ref(false);
const editClient = ref(null);
const editTags = ref([]);
const editGroup = ref('');
const editNotes = ref('');
const editRegion = ref('');
const editFocus = ref(null);
const saving = ref(false);
const armed = ref(false);
let armTimer = null;

// Programmatic focus target for the tags multiselect (NSelect has no DOM id).
const editTagsSel = ref(null);

function disarmKick() {
  armed.value = false;
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
}

function armKick() {
  if (!editClient.value) return;
  if (!armed.value) {
    armed.value = true;
    armTimer = setTimeout(disarmKick, 5000);
    return;
  }
  disarmKick();
  kickClient(editClient.value.id)
    .then((d) => {
      if (d.success) {
        message.success('已断开节点');
        editOpen.value = false;
        editClient.value = null;
      } else {
        message.error('操作失败: ' + (d.message || ''));
      }
    })
    .catch((err) => message.error('请求失败: ' + err.message));
}

function closeEdit() {
  editOpen.value = false;
  disarmKick();
}

function saveEdit() {
  const client = editClient.value;
  if (!client) return;
  saving.value = true;
  const tagsArr = (editTags.value || [])
    .map((t) => String(t).trim())
    .filter(Boolean);
  const p1 = saveClientMeta(client.id, 'tags', tagsArr);
  const p2 = saveClientMeta(client.id, 'group', editGroup.value.trim() || null);
  const p3 = saveClientMeta(client.id, 'notes', editNotes.value.trim());
  const p4 = saveClientMeta(client.id, 'region', editRegion.value.trim());
  Promise.allSettled([p1, p2, p3, p4]).then((results) => {
    saving.value = false;
    const failed = results.filter((r) => r.status !== 'fulfilled' || !r.value.success);
    if (failed.length === 0) {
      message.success('保存完成');
      closeEdit();
      return;
    }
    let reason = '';
    for (const r of failed) {
      if (r.status === 'rejected') {
        reason = r.reason && r.reason.message ? r.reason.message : '';
      } else if (r.value && r.value.message) {
        reason = r.value.message;
      }
      if (reason) break;
    }
    message.error(reason || '保存失败 (' + failed.length + '/' + results.length + ')');
  });
}

// Auto-focus requested field once modal opens
watch(editOpen, (open) => {
  if (!open || !editFocus.value) return;
  setTimeout(() => {
    const field = editFocus.value;
    if (field === 'tags') {
      if (editTagsSel.value && editTagsSel.value.focus) editTagsSel.value.focus();
      return;
    }
    const map = { notes: '#editNotes', region: '#editRegion', group: '#editGroup' };
    const el = document.querySelector(map[field]);
    if (el) el.focus();
  }, 120);
});

let refreshTimer = null;

// The status dot column judges liveness from lastSeen, but the server only
// pushes status on events (heartbeats alone do not notify), so an idle panel
// would show clients as stale/dead while they are actually online. Refresh on
// mount and periodically while this page is visible to keep lastSeen fresh.
onMounted(() => {
  requestStatus().catch(() => {});
  refreshTimer = setInterval(() => {
    requestStatus().catch(() => {});
  }, 15000);
});

onBeforeUnmount(() => {
  if (armTimer) clearTimeout(armTimer);
  if (refreshTimer) clearInterval(refreshTimer);
});

const cbRowClass = (row) => {
  const st = (row.circuitBreaker || { state: 'closed' }).state;
  return st === 'open' ? 'np-cb-row-open' : undefined;
};
</script>

<template>
  <div class="nodes">
    <!-- Toolbar -->
    <div class="nodes-toolbar">
      <NInput
        v-model:value="search"
        clearable
        placeholder="搜索节点 (ID / 主机名 / IP)..."
        style="width: 280px"
      >
        <template #prefix><AppIcon name="search" :size="14" /></template>
      </NInput>

      <NSelect
        v-model:value="groupFilter"
        clearable
        filterable
        placeholder="全部分组"
        :options="groupOptions"
        style="width: 160px"
        size="small"
      />

      <NPopover trigger="click" placement="bottom-start" style="padding: 8px">
        <template #trigger>
          <button class="np-cols-btn">
            <AppIcon name="sliders" :size="14" />
            <span>已显示 {{ visibleCount }} 个字段</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </template>
        <div class="np-cols-panel">
          <div v-for="col in ALL_COLUMNS" :key="col.key" class="np-cols-item">
            <NCheckbox
              :checked="visibleKeys.includes(col.key)"
              :disabled="visibleKeys.includes(col.key) && visibleKeys.length === 1"
              @update:checked="() => toggleCol(col.key)"
            >
              {{ col.label }}
            </NCheckbox>
          </div>
          <div class="np-cols-foot">
            <NButton size="tiny" @click="showAllCols">全部显示</NButton>
          </div>
        </div>
      </NPopover>

      <span class="nodes-count">共 {{ clients.length }} 个节点</span>
    </div>

    <!-- Table -->
    <NDataTable
      :columns="tableColumns"
      :data="filtered"
      :loading="loading"
      :scroll-x="1500"
      :row-class-name="cbRowClass"
      :bordered="false"
      :single-line="false"
      class="np-table"
      :row-props="() => ({})"
    >
      <template #empty>
        <div style="padding: 34px 0; color: var(--np-text-muted); text-align: center">
          {{ clients.length === 0 ? '等待客户端节点连接...' : '没有匹配的节点' }}
        </div>
      </template>
    </NDataTable>

    <!-- Edit node modal -->
    <NModal
      :show="editOpen"
      preset="card"
      :style="{ width: '480px', maxWidth: '94vw' }"
      :title="null"
      @update:show="(v) => !v && closeEdit()"
    >
      <div class="np-edit-head">
        <AppIcon name="edit" :size="17" />
        <span>编辑节点信息</span>
        <span class="np-edit-id">
          {{ editClient ? editClient.id.substring(0, 8) + '…' : '' }}
        </span>
      </div>

      <div class="np-form">
        <label>标签</label>
        <NSelect
          ref="editTagsSel"
          v-model:value="editTags"
          multiple
          filterable
          tag
          :options="tagOptions"
          placeholder="选择或输入标签"
        />
      </div>
      <div class="np-form">
        <label>分组</label>
        <NInput v-model:value="editGroup" id="editGroup" placeholder="输入分组名称" />
      </div>
      <div class="np-form">
        <label>备注</label>
        <NInput v-model:value="editNotes" id="editNotes" type="textarea" :rows="2" placeholder="内部备注" />
      </div>
      <div class="np-form">
        <label>区域覆盖</label>
        <NInput v-model:value="editRegion" id="editRegion" placeholder="如: beijing" />
      </div>

      <template #footer>
        <div class="np-edit-foot">
          <NButton size="small" type="error" :class="{ armed }" @click="armKick">
            {{ armed ? '确认断开该节点' : '断开该节点' }}
          </NButton>
          <div style="display: flex; gap: 8px">
            <NButton size="small" @click="closeEdit">取消</NButton>
            <NButton size="small" type="primary" :loading="saving" @click="saveEdit">保存</NButton>
          </div>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.nodes { display: flex; flex-direction: column; gap: 12px; }
.nodes-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.np-cols-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--np-border-soft);
  background: var(--np-bg-soft);
  color: var(--np-text-2);
  font-size: 13px;
  cursor: pointer;
}
.np-cols-btn:hover { border-color: var(--np-primary); color: var(--np-text); }
.np-cols-panel { width: 220px; }
.np-cols-item {
  padding: 3px 2px;
  font-size: 13px;
  color: var(--np-text-2);
}
.np-cols-foot {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--np-border-soft);
  text-align: right;
}
.nodes-count { font-size: 13px; color: var(--np-text-muted); }

.np-edit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 6px;
}
.np-edit-id {
  margin-left: auto;
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 12px;
  color: var(--np-text-muted);
  font-weight: 400;
}
.np-edit-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.np-edit-foot .armed {
  animation: np-pulse 0.7s infinite alternate;
}
@keyframes np-pulse {
  from { box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.4); }
  to { box-shadow: 0 0 0 7px rgba(248, 81, 73, 0); }
}
.np-form {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 12px;
}
.np-form label { font-size: 12.5px; color: var(--np-text-2); }
.np-group-chip {
  display: inline-block;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 20px;
  color: var(--np-primary);
  background: rgba(var(--np-primary-rgb, 24, 160, 88), 0.12);
  border: 1px solid rgba(var(--np-primary-rgb, 24, 160, 88), 0.35);
}
.np-region-ov { color: var(--np-primary); font-weight: 600; }
</style>
