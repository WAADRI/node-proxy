// =============================================================================
// Node-Proxy Web Control Panel - Frontend
// =============================================================================
(function () {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let lastData = null;

  // Get auth token
  function getToken() {
    return localStorage.getItem('np_token') || '';
  }

  function fetchWithAuth(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['Authorization'] = 'Bearer ' + getToken();
    return fetch(url, options);
  }

  // ===========================================================================
  // Logout
  // ===========================================================================
  window.doLogout = function () {
    const token = getToken();
    fetch('/api/logout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    }).finally(() => {
      localStorage.removeItem('np_token');
      document.cookie = 'token=; path=/; max-age=0';
      window.location.href = '/login';
    });
  };

  // ===========================================================================
  // WebSocket Connection
  // ===========================================================================
  function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getToken();
    const url = `${proto}//${window.location.host}/web-ws?token=${encodeURIComponent(token)}`;

    if (ws) {
      try { ws.close(); } catch (_) {}
    }

    ws = new WebSocket(url);

    ws.onopen = () => {
      setConnectionStatus(true);
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          lastData = msg.data;
          renderDashboard(msg.data);
        }
      } catch (err) {
        console.error('Invalid message:', err);
      }
    };

    ws.onclose = () => {
      setConnectionStatus(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  }

  function setConnectionStatus(connected) {
    const dot = document.getElementById('wsDot');
    const label = document.getElementById('wsLabel');
    const badge = document.getElementById('serverBadge');
    const statusText = document.getElementById('serverStatusText');

    if (connected) {
      dot.className = 'indicator-dot connected';
      label.textContent = 'WebSocket 已连接 (实时更新)';
      badge.className = 'status-badge online';
      statusText.textContent = '已连接';
    } else {
      dot.className = 'indicator-dot disconnected';
      label.textContent = 'WebSocket 未连接 (3秒后重连)';
      badge.className = 'status-badge offline';
      statusText.textContent = '已断开';
    }
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================
  function renderDashboard(data) {
    if (!data) return;

    const { clients, total, server, routing, tags, circuitBreaker, bandwidth } = data;

    // Stats
    document.getElementById('statOnline').textContent = total;
    document.getElementById('statPendingReqs').innerHTML =
      clients.reduce((s, c) => s + c.pendingRequestsCount, 0) + ' <span class="unit">待处理</span>';
    document.getElementById('statTunnels').innerHTML =
      clients.reduce((s, c) => s + c.pendingTunnelsCount, 0) + ' <span class="unit">条</span>';

    if (server && server.uptime) {
      const uptime = formatUptime(server.uptime);
      document.getElementById('statUptime').innerHTML = uptime;
    }

    // Phase 2 stats
    if (routing) {
      const strategyLabel = STRATEGY_LABELS[routing.strategy] || routing.strategy || 'random';
      document.getElementById('statRouting').textContent = strategyLabel;
      document.getElementById('statRouting').title = '可用策略: ' + (routing.availableStrategies || []).join(', ');
    }
    if (circuitBreaker) {
      const openCount = (clients || []).filter(c => c.circuitBreaker && c.circuitBreaker.state === 'open').length;
      document.getElementById('statCB').textContent = openCount > 0 ? openCount + ' ⚠️' : '✅ 正常';
    }
    if (bandwidth) {
      document.getElementById('statBW').textContent = bandwidth.enabled ? '✅ 已开启' : '关闭';
    }
    if (server) {
      document.getElementById('statFailed').textContent = server.failedRequests || 0;
    }

    document.getElementById('clientCount').textContent = `共 ${total} 个节点`;

    // Last update time
    document.getElementById('lastUpdateLabel').textContent =
      `最后更新: ${new Date().toLocaleTimeString()}`;

    // Table
    renderClientTable(clients);
  }

  function renderClientTable(clients) {
    const tbody = document.getElementById('clientTableBody');
    const search = (document.getElementById('searchInput').value || '').toLowerCase();

    if (!clients || clients.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="16" class="no-data">
            <div class="icon">🔌</div>
            <div class="hint">等待客户端节点连接...</div>
          </td>
        </tr>
      `;
      return;
    }

    // Filter
    const filtered = clients.filter((c) => {
      if (!search) return true;
      const info = c.info || {};
      return (
        c.id.toLowerCase().includes(search) ||
        (info.hostname || '').toLowerCase().includes(search) ||
        (info.ip || '').toLowerCase().includes(search) ||
        (info.platform || '').toLowerCase().includes(search) ||
        (info.region || '').toLowerCase().includes(search)
      );
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="16" class="no-data">
            <div class="hint">没有匹配的节点</div>
          </td>
        </tr>
      `;
      return;
    }

    const now = Date.now();
    let html = '';
    for (const c of filtered) {
      const info = c.info || {};
      const lastSeenAgo = now - c.lastSeen;
      const connectedAgo = now - c.connectedAt;
      const isAlive = lastSeenAgo < 30000; // 30s
      const isStale = lastSeenAgo >= 30000 && lastSeenAgo < 120000;

      let dotClass = 'dead';
      if (isAlive) dotClass = 'alive';
      else if (isStale) dotClass = 'stale';

      const tags = c.tags || [];
      const tagsHtml = tags.length > 0
        ? tags.map(t => `<span class="tag-badge">${escapeHtml(t)}</span>`).join(' ')
        : '<span class="no-tags">-</span>';
      const alias = c.alias || '';
      const notes = c.notes || '';
      const effectiveRegion = c.region || info.region || '-';
      const regionClass = c.region ? 'region-override' : '';
      const cb = c.circuitBreaker || { state: 'closed' };
      const cbState = cb.state || 'closed';
      const cbClass = cbState === 'open' ? ' class="cb-open-row"' : '';

      html += `
        <tr${cbClass}>
          <td><span class="online-dot ${dotClass}"></span></td>
          <td><span class="client-id" title="${escapeHtml(c.id)}">${escapeHtml(c.id.substring(0, 8))}...</span></td>
          <td><span class="client-hostname">${escapeHtml(alias || info.hostname || '-')}</span></td>
          <td><span class="client-ip">${escapeHtml(info.ip || info.localIp || '-')}</span></td>
          <td>${escapeHtml(info.platform || '-')} ${info.arch ? '(' + escapeHtml(info.arch) + ')' : ''}</td>
          <td class="${regionClass} cell-edit" title="点击编辑区域" onclick="window.editClientMeta('${c.id}','region')">${escapeHtml(effectiveRegion)}</td>
          <td>${tagsHtml}</td>
          <td class="client-alias cell-edit" title="点击编辑别名" onclick="window.editClientMeta('${c.id}','alias')">
            ${alias ? escapeHtml(alias) : '<span class="dim">-</span>'}
          </td>
          <td class="client-notes cell-edit" title="点击编辑备注" onclick="window.editClientMeta('${c.id}','notes')">
            ${notes ? escapeHtml(notes.substring(0, 30)) + (notes.length > 30 ? '...' : '') : '<span class="dim">-</span>'}
          </td>
          <td class="client-pending">${c.pendingRequestsCount}</td>
          <td class="client-pending">${c.pendingTunnelsCount}</td>
          <td class="client-pending">${c.avgResponseTime || '-'}</td>
          <td><span class="cb-badge ${cbState}">${cbState === 'open' ? '🔴 熔断' : cbState === 'half_open' ? '🟡 测试' : '🟢 正常'}</span></td>
          <td class="time-cell" title="${new Date(c.connectedAt).toLocaleString()}">${formatDuration(connectedAgo)}</td>
          <td class="time-cell" title="${new Date(c.lastSeen).toLocaleString()}">${formatDuration(lastSeenAgo)}</td>
          <td>
            <button class="btn btn-sm" onclick="window.editClientMeta('${c.id}')">编辑</button>
            <button class="btn btn-danger btn-sm" onclick="window.kickClient('${c.id}')">断开</button>
          </td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
  }

  // ===========================================================================
  // Formatting
  // ===========================================================================
  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    let parts = [];
    if (d > 0) parts.push(d + '天');
    if (h > 0) parts.push(h + '时');
    if (m > 0) parts.push(m + '分');
    parts.push(s + '秒');
    return parts.join(' ') + ' <span class="unit"></span>';
  }

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + '秒前';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + '分钟前';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + '小时前';
    const days = Math.floor(hours / 24);
    return days + '天前';
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===========================================================================
  // Actions
  // ===========================================================================
  window.kickClient = function (clientId) {
    if (!confirm('确定要断开节点 ' + clientId.substring(0, 8) + '... 吗？')) return;
    fetchWithAuth('/api/kick/' + clientId, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          showToast('已断开节点', 'success');
        } else {
          showToast('操作失败: ' + (d.message || ''), 'error');
        }
      })
      .catch((err) => showToast('请求失败: ' + err.message, 'error'));
  };

  window.kickAll = function () {
    if (!confirm('确定要断开所有在线节点吗？')) return;
    const ids = lastData && lastData.clients ? lastData.clients.map((c) => c.id) : [];
    if (ids.length === 0) {
      showToast('没有在线节点', 'info');
      return;
    }
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      fetchWithAuth('/api/kick/' + id, { method: 'POST' })
        .then((r) => r.json())
        .then((d) => {
          if (d.success) done++;
          else failed++;
          if (done + failed === ids.length) {
            showToast(`已断开 ${done} 个节点${failed ? ', ' + failed + ' 个失败' : ''}`, 'success');
          }
        })
        .catch(() => {
          failed++;
          if (done + failed === ids.length) {
            showToast(`已断开 ${done} 个节点${failed ? ', ' + failed + ' 个失败' : ''}`, done > 0 ? 'success' : 'error');
          }
        });
    }
  };

  window.editClientMeta = function (clientId, focusField) {
    if (!lastData) return;
    const client = lastData.clients.find(c => c.id === clientId);
    if (!client) return;
    document.getElementById('editClientId').value = clientId;
    document.getElementById('editAlias').value = client.alias || '';
    document.getElementById('editNotes').value = client.notes || '';
    document.getElementById('editRegion').value = client.region || client.info?.region || '';
    document.getElementById('editMetaModal').classList.add('active');
    if (focusField) {
      const el = document.getElementById('edit' + focusField.charAt(0).toUpperCase() + focusField.slice(1));
      if (el) { el.focus(); el.select(); }
    }
  };

  window.saveClientMeta = function () {
    const clientId = document.getElementById('editClientId').value;
    if (!clientId) return;
    const alias = document.getElementById('editAlias').value.trim();
    const notes = document.getElementById('editNotes').value.trim();
    const region = document.getElementById('editRegion').value.trim();
    let pending = 0;
    let failed = 0;

    function done() {
      if (pending === 0) {
        showToast('保存完成' + (failed ? ', ' + failed + ' 个失败' : ''), failed > 0 ? 'error' : 'success');
        document.getElementById('editMetaModal').classList.remove('active');
        refreshNow();
      }
    }

    pending++;
    fetchWithAuth('/api/v1/client/' + clientId + '/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    }).then(r => r.json()).then(d => { if (!d.success) failed++; pending--; done(); }).catch(() => { failed++; pending--; done(); });

    pending++;
    fetchWithAuth('/api/v1/client/' + clientId + '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    }).then(r => r.json()).then(d => { if (!d.success) failed++; pending--; done(); }).catch(() => { failed++; pending--; done(); });

    pending++;
    fetchWithAuth('/api/v1/client/' + clientId + '/region', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region }),
    }).then(r => r.json()).then(d => { if (!d.success) failed++; pending--; done(); }).catch(() => { failed++; pending--; done(); });
  };

  window.hideEditMetaModal = function () {
    document.getElementById('editMetaModal').classList.remove('active');
  };

  window.refreshNow = function () {
    fetchWithAuth('/api/status')
      .then((r) => r.json())
      .then((data) => {
        lastData = data;
        renderDashboard(data);
        showToast('已刷新', 'info');
      })
      .catch((err) => showToast('刷新失败: ' + err.message, 'error'));
  };

  // ===========================================================================
  // Runtime Settings panel
  // ===========================================================================
  const STRATEGY_LABELS = { random: '随机', 'least-loaded': '最少负载', 'fastest-response': '最快响应', weighted: '加权' };
  const STRATEGY_DESC = {
    random: '从在线节点中随机选择',
    'least-loaded': '优先选择待处理请求最少的节点',
    'fastest-response': '优先选择平均响应最快的节点',
    weighted: '按节点权重比例分配（权重在节点行调整）',
  };

  let settingsData = null;

  window.openSettingsModal = function () {
    document.getElementById('settingsModal').classList.add('active');
    loadSettings();
  };

  window.hideSettingsModal = function () {
    document.getElementById('settingsModal').classList.remove('active');
  };

  function loadSettings() {
    fetchWithAuth('/api/v1/settings')
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error(d.message || '加载失败');
        settingsData = d;
        renderSettings(d);
      })
      .catch((err) => showToast('加载设置失败: ' + err.message, 'error'));
  }

  // Highlight the selected strategy card on click (radio inputs are hidden).
  // Bound once on the container; renderSettings only replaces innerHTML.
  document.getElementById('routingOptions').addEventListener('change', function (e) {
    if (e.target && e.target.name === 'routingStrategy') {
      this.querySelectorAll('.strategy-option').forEach((opt) => {
        const input = opt.querySelector('input');
        opt.classList.toggle('selected', !!(input && input.checked));
      });
    }
  });

  function renderSettings(d) {
    const rt = d.runtime || {};
    const ed = d.editable || {};

    // --- routing ---
    const cur = (rt.routing && rt.routing.strategy) || 'random';
    const list = (rt.routing && rt.routing.available) || Object.keys(STRATEGY_LABELS);
    document.getElementById('routingOptions').innerHTML = list
      .map((s) => `
        <label class="strategy-option${s === cur ? ' selected' : ''}">
          <input type="radio" name="routingStrategy" value="${s}" ${s === cur ? 'checked' : ''} ${ed.routing ? '' : 'disabled'}>
          <span class="so-name">${STRATEGY_LABELS[s] || s}</span>
          <span class="so-desc">${STRATEGY_DESC[s] || ''}</span>
        </label>`)
      .join('');

    // --- circuit breaker ---
    const cb = rt.circuit_breaker || {};
    setField('cbErrorThreshold', cb.error_threshold);
    setField('cbWindowMs', cb.window_ms);
    setField('cbRecoveryMs', cb.recovery_timeout_ms);
    setField('cbHalfOpen', cb.half_open_max_attempts);

    // --- bandwidth (KB/s in the UI) ---
    const bw = rt.bandwidth || {};
    document.getElementById('bwEnabled').checked = !!bw.enabled;
    setField('bwGlobalRateKb', bw.global_rate != null ? Math.round(bw.global_rate / 1024) : 0);
    setField('bwDefaultRateKb', bw.default_rate != null ? Math.round(bw.default_rate / 1024) : 0);

    // --- client params ---
    const cl = rt.client || {};
    setField('clRequestTimeout', cl.request_timeout);
    setField('clTunnelTimeout', cl.tunnel_timeout);
    setField('clMaxConcurrent', cl.max_concurrent);

    // --- cache ---
    const ca = rt.cache || {};
    setField('cacheTtlMs', ca.default_ttl);

    // --- editability ---
    setGroupEditable('groupRouting', ed.routing);
    setGroupEditable('groupCircuitBreaker', ed.circuit_breaker);
    setGroupEditable('groupBandwidth', ed.bandwidth);
    setGroupEditable('groupClient', ed.client);
    setGroupEditable('groupCache', ed.cache);

    // --- restart-only read-only display ---
    const ro = d.restart_only || {};
    document.getElementById('roWebPort').textContent = (ro.server && ro.server.web_port) != null ? ro.server.web_port : '-';
    document.getElementById('roHttpPort').textContent = (ro.server && ro.server.http_proxy_port) != null ? ro.server.http_proxy_port : '-';
    document.getElementById('roSocksPort').textContent = (ro.server && ro.server.socks5_port) != null ? ro.server.socks5_port : '-';
    document.getElementById('roWebUser').textContent = (ro.auth && ro.auth.web_username) || '-';
    document.getElementById('roLogLevel').textContent = ro.logging_level || '-';
    const tokenOk = ro.auth && ro.auth.token_configured;
    const roToken = document.getElementById('roToken');
    if (roToken) {
      roToken.textContent = tokenOk ? '已设置为非默认值' : '仍为默认值 node-proxy-default-token ⚠';
      roToken.className = tokenOk ? 'ro-ok' : 'ro-warn';
    }
  }

  function setField(id, value) {
    const el = document.getElementById(id);
    if (el && value != null) el.value = value;
  }

  function setGroupEditable(groupId, editable) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('input,button').forEach((el) => { el.disabled = !editable; });
    const hint = group.querySelector('.perm-hint');
    if (hint) hint.style.display = editable ? 'none' : 'inline';
  }

  function numField(id) {
    const el = document.getElementById(id);
    const v = parseInt(el.value, 10);
    if (isNaN(v)) return null;
    return v;
  }

  window.saveSettingsGroup = function (group) {
    const body = {};
    switch (group) {
      case 'routing': {
        const checked = document.querySelector('#settingsModal input[name=routingStrategy]:checked');
        if (!checked) return showToast('请先选择路由策略', 'error');
        body.strategy = checked.value;
        break;
      }
      case 'circuit_breaker':
        body.error_threshold = numField('cbErrorThreshold');
        body.window_ms = numField('cbWindowMs');
        body.recovery_timeout_ms = numField('cbRecoveryMs');
        body.half_open_max_attempts = numField('cbHalfOpen');
        break;
      case 'bandwidth':
        body.enabled = document.getElementById('bwEnabled').checked;
        body.global_rate = numField('bwGlobalRateKb') != null ? numField('bwGlobalRateKb') * 1024 : 0;
        body.default_rate = numField('bwDefaultRateKb') != null ? numField('bwDefaultRateKb') * 1024 : 0;
        break;
      case 'client':
        body.request_timeout = numField('clRequestTimeout');
        body.tunnel_timeout = numField('clTunnelTimeout');
        body.max_concurrent = numField('clMaxConcurrent');
        break;
      case 'cache':
        body.default_ttl = numField('cacheTtlMs');
        break;
      default:
        return;
    }
    const hasNull = Object.values(body).some((v) => v === null);
    if (hasNull) return showToast('请填写有效的数字', 'error');
    fetchWithAuth('/api/v1/settings/' + group, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return showToast('保存失败: ' + (d.message || ''), 'error');
        showToast('已保存并即时生效', 'success');
        // POST responses carry no `editable` field - reload from GET to keep
        // controls enabled and show server-confirmed values.
        loadSettings();
        // Refresh the main dashboard stats (routing/bandwidth cards) right away
        // so the change is visibly applied.
        refreshNow();
      })
      .catch((err) => showToast('请求失败: ' + err.message, 'error'));
  };

  window.resetSettingsGroup = function (group) {
    if (!confirm('确定将该组恢复为 config.yaml 默认值？')) return;
    fetchWithAuth('/api/v1/settings/' + group + '/reset', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return showToast('恢复失败: ' + (d.message || ''), 'error');
        showToast('已恢复默认值', 'success');
        loadSettings();
        refreshNow();
      })
      .catch((err) => showToast('请求失败: ' + err.message, 'error'));
  };

  // ===========================================================================
  // Broadcast
  // ===========================================================================
  window.showBroadcastModal = function () {
    document.getElementById('broadcastModal').classList.add('active');
    document.getElementById('broadcastMessage').value = '';
    document.getElementById('broadcastMessage').focus();
  };

  window.hideBroadcastModal = function () {
    document.getElementById('broadcastModal').classList.remove('active');
  };

  window.doBroadcast = function () {
    const message = document.getElementById('broadcastMessage').value.trim();
    if (!message) {
      showToast('请输入消息内容', 'error');
      return;
    }
    fetchWithAuth('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          showToast(`广播已发送给 ${d.count} 个节点`, 'success');
          hideBroadcastModal();
        } else {
          showToast('广播失败: ' + (d.message || ''), 'error');
        }
      })
      .catch((err) => showToast('请求失败: ' + err.message, 'error'));
  };

  // Close modal on overlay click
  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('modal-overlay')) {
      hideBroadcastModal();
      hideEditMetaModal();
      hideSettingsModal();
    }
  });

  // Close modal on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideBroadcastModal();
      hideEditMetaModal();
      hideSettingsModal();
    }
  });

  // ===========================================================================
  // Filter
  // ===========================================================================
  window.filterClients = function () {
    if (lastData) renderDashboard(lastData);
  };

  // ===========================================================================
  // Toast
  // ===========================================================================
  function showToast(text, type) {
    type = type || 'info';
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ===========================================================================
  // Init
  // ===========================================================================
  // Initial load
  refreshNow();

  // Connect WebSocket for live updates
  connectWebSocket();

  // Periodic refresh fallback (every 30s if WS fails)
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      refreshNow();
    }
  }, 30000);

})();