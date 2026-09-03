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
      const strategyLabel = routing.strategy || 'random';
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
          <td class="${regionClass}">${escapeHtml(effectiveRegion)}</td>
          <td>${tagsHtml}</td>
          <td class="client-alias" title="${escapeHtml(alias) || '点击编辑别名'}">
            ${alias ? escapeHtml(alias) : '<span class="dim">-</span>'}
          </td>
          <td class="client-notes" title="${escapeHtml(notes) || '点击编辑备注'}">
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

  window.editClientMeta = function (clientId) {
    if (!lastData) return;
    const client = lastData.clients.find(c => c.id === clientId);
    if (!client) return;
    document.getElementById('editClientId').value = clientId;
    document.getElementById('editAlias').value = client.alias || '';
    document.getElementById('editNotes').value = client.notes || '';
    document.getElementById('editRegion').value = client.region || client.info?.region || '';
    document.getElementById('editMetaModal').classList.add('active');
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
    }
  });

  // Close modal on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideBroadcastModal();
      hideEditMetaModal();
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