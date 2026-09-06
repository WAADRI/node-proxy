// =============================================================================
// NetworkTestManager - In-panel network testing toolkit (issue #31)
// Tools: ping / tcping / http speed test / traceroute / dns lookup
// - Targets are tested sequentially (round-robin, never concurrent), up to 256.
// - HTTP body capped at 1MB to avoid abuse.
// - Pure Node.js + npm deps only (raw-socket used for ICMP/UDP when available).
// =============================================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const dnsPromises = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const { URL } = require('url');

const MAX_TARGETS = 256;
const HTTP_BODY_LIMIT = 1024 * 1024; // 1 MB
const TRACEROUTE_MAX_HOPS = 30;
const TRACEROUTE_PROBES = 1;

// ICMP/UDP raw sockets (optional; needs native module + root/CAP_NET_RAW)
let raw = null;
let rawError = null;
try {
  raw = require('raw-socket');
} catch (err) {
  rawError = err.message;
}

class NetworkTestManager {
  constructor(logger) {
    this.log = logger;
    this.tasks = new Map(); // id -> task
    this._running = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  start(type, targets, options = {}) {
    if (!['ping', 'tcping', 'http', 'dns', 'traceroute'].includes(type)) {
      const err = new Error('Unknown test type: ' + type);
      err.code = 400;
      throw err;
    }
    const list = (Array.isArray(targets) ? targets : []).map((t) => String(t).trim()).filter(Boolean);
    if (list.length === 0) {
      const err = new Error('No targets provided');
      err.code = 400;
      throw err;
    }
    if (list.length > MAX_TARGETS) {
      const err = new Error(`Too many targets (max ${MAX_TARGETS})`);
      err.code = 400;
      throw err;
    }
    const id = uuidv4().slice(0, 12);
    const task = {
      id,
      type,
      targets: list,
      options,
      state: 'queued',
      createdAt: Date.now(),
      results: [],
      error: null,
    };
    this.tasks.set(id, task);
    this._kick();
    return id;
  }

  get(id) {
    const t = this.tasks.get(id);
    if (!t) return null;
    return {
      id: t.id,
      type: t.type,
      state: t.state,
      createdAt: t.createdAt,
      total: t.targets.length,
      done: t.results.length,
      results: t.results,
      error: t.error,
    };
  }

  // One global test at a time (anti-abuse: sequential work only)
  _kick() {
    if (this._running) return;
    for (const task of this.tasks.values()) {
      if (task.state === 'queued') {
        this._running = task;
        task.state = 'running';
        this._run(task)
          .catch((err) => {
            task.error = err.message;
            task.state = 'error';
          })
          .finally(() => {
            this._running = null;
            if (task.state === 'running') task.state = 'done';
            // opportunistic gc of finished tasks
            if (this.tasks.size > 100) {
              for (const [k, v] of this.tasks) {
                if (v.state === 'done' || v.state === 'error') this.tasks.delete(k);
                if (this.tasks.size <= 100) break;
              }
            }
            this._kick();
          });
        return;
      }
    }
  }

  async _run(task) {
    const { type, targets, options } = task;
    for (let i = 0; i < targets.length; i++) {
      if (task.state !== 'running') break; // cancelled
      const target = targets[i];
      let res;
      try {
        res = await this.runTarget(type, target, options);
      } catch (err) {
        res = { ok: false, error: err.message || String(err) };
      }
      task.results.push(Object.assign({ target, index: i + 1 }, res));
    }
  }

  // ---------------------------------------------------------------------------
  // Individual tools
  // ---------------------------------------------------------------------------
  async runTarget(type, target, options = {}) {
    switch (type) {
      case 'ping': return this._ping(target, options);
      case 'tcping': return this._tcping(target, options);
      case 'http': return this._httpTest(target, options);
      case 'dns': return this._dnsLookup(target, options);
      case 'traceroute': return this._traceroute(target, options);
      default: throw new Error('Unknown type ' + type);
    }
  }

  // --- ping ---------------------------------------------------------------
  async _ping(target, options = {}) {
    const count = Math.min(Math.max(parseInt(options.count, 10) || 3, 1), 10);
    const timeout = parseInt(options.timeout, 10) || 2000;
    const host = this._hostOf(target);

    // ICMP echo via raw-socket when the native module is available + privileged
    if (raw) {
      try {
        return await this._icmpPing(host, count, timeout);
      } catch (err) {
        this.log.warn({ host, err: err.message }, 'ICMP ping failed, falling back to TCP');
      }
    }
    return this._tcpPingFallback(host, count, timeout);
  }

  // Full ICMP echo ping (needs root / CAP_NET_RAW on Linux)
  _icmpPing(host, count, timeout) {
    return new Promise((resolve, reject) => {
      require('dns').lookup(host, { family: 4 }, (err, addr) => {
        if (err) return reject(new Error('解析失败: ' + host));
        let sock;
        try {
          sock = raw.createSocket({ protocol: raw.Protocol.ICMP });
        } catch (e) {
          return reject(new Error('无法创建 ICMP socket: ' + e.message));
        }
        const times = [];
        let sent = 0;
        let replied = 0;
        const sendMap = {}; // seq -> startedAt
        const id = (process.pid & 0xffff);
        const seqBase = Math.floor(Math.random() * 0xffff);
        const settled = { done: false };
        const finish = (error) => {
          if (settled.done) return;
          settled.done = true;
          try { sock.close(); } catch (_) {}
          if (error) return reject(error);
          if (!times.length) return reject(new Error('无 ICMP 应答（主机可能禁 ping 或超时）'));
          const avg = times.reduce((a, b) => a + b, 0) / times.length;
          resolve({
            ok: true,
            mode: 'icmp',
            ms: Math.round(avg),
            detail: `min ${Math.round(Math.min(...times))}ms / avg ${Math.round(avg)}ms / max ${Math.round(Math.max(...times))}ms (${times.length}/${count} 回)`,
          });
        };

        const sendOne = (seq) => {
          const packet = Buffer.alloc(8 + 24);
          packet.writeUInt8(8, 0); // type: echo request
          packet.writeUInt8(0, 1); // code
          packet.writeUInt16BE(0, 2); // checksum (filled below)
          packet.writeUInt16BE(id, 4);
          packet.writeUInt16BE(seq, 6);
          for (let i = 8; i < packet.length; i++) packet.writeUInt8(i & 0xff, i);
          // checksum
          let sum = 0;
          for (let i = 0; i < packet.length; i += 2) {
            sum += (packet[i] << 8) + packet[i + 1];
          }
          while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
          packet.writeUInt16BE(~sum & 0xffff, 2);
          sent++;
          sendMap[seq] = Date.now();
          sock.send(packet, 0, packet.length, 0, addr, (err) => {
            if (err) finish(new Error('发送失败: ' + err.message));
          });
        };

        sock.on('message', (buffer) => {
          if (buffer.length < 8) return;
          const type = buffer.readUInt8(0);
          const replyId = buffer.readUInt16BE(4);
          if (type !== 0 || replyId !== id) return;
          const seq = buffer.readUInt16BE(6);
          const startedAt = sendMap[seq];
          if (startedAt == null) return;
          delete sendMap[seq];
          replied++;
          times.push(Date.now() - startedAt);
          if (replied >= count) finish();
        });
        sock.on('error', (e) => finish(new Error('ICMP socket error: ' + e.message)));

        let idx = 0;
        const loop = () => {
          if (settled.done) return;
          if (idx >= count) {
            // wait a short grace for late replies, then settle
            setTimeout(() => finish(), Math.min(timeout, 500));
            return;
          }
          sendOne((seqBase + idx) & 0xffff);
          idx++;
          setTimeout(loop, timeout / count);
        };
        loop();
      });
    });
  }

  // TCP-connect fallback ping (no privileges needed) - labelled as such
  async _tcpPingFallback(host, count, timeout) {
    const times = [];
    const probe = () =>
      this._tcpProbe(host, 443, timeout).catch(() => this._tcpProbe(host, 80, timeout));
    for (let i = 0; i < count; i++) {
      const t = await probe();
      if (t != null) times.push(t);
      if (i < count - 1) await this._sleep(200);
    }
    if (!times.length) throw new Error('TCP ping: no reply (ICMP unavailable, TCP 80/443 unreachable)');
    const ms = times.reduce((a, b) => a + b, 0) / times.length;
    return {
      ok: true,
      mode: 'tcp-fallback',
      ms: Math.round(ms),
      detail: `min ${Math.round(Math.min(...times))}ms / avg ${Math.round(ms)}ms / max ${Math.round(Math.max(...times))}ms (${times.length}/${count} 回, TCP fallback)`,
      note: 'ICMP 不可用（需要 raw-socket 原生模块 + root/CAP_NET_RAW），已用 TCP 80/443 连接回退',
    };
  }

  // --- tcping -------------------------------------------------------------
  async _tcping(target, options = {}) {
    const { host, port } = this._hostPortOf(target, options.port || 80);
    const timeout = parseInt(options.timeout, 10) || 3000;
    const ms = await this._tcpProbe(host, port, timeout);
    if (ms == null) throw new Error(`无法连接 ${host}:${port} (超时 ${timeout}ms)`);
    return { ok: true, ms: Math.round(ms), port, detail: `${host}:${port} 可达` };
  }

  _tcpProbe(host, port, timeout) {
    return new Promise((resolve) => {
      const started = Date.now();
      const sock = net.connect({ host, port }, () => {
        const ms = Date.now() - started;
        sock.destroy();
        resolve(ms);
      });
      sock.on('error', () => { sock.destroy(); resolve(null); });
      sock.setTimeout(timeout, () => { sock.destroy(); resolve(null); });
    });
  }

  // --- HTTP request speed test ---------------------------------------------
  async _httpTest(target, options = {}) {
    const url = new URL(/^https?:\/\//i.test(target) ? target : 'http://' + target);
    const method = String(options.method || 'GET').toUpperCase();
    const redirects = Math.min(Math.max(parseInt(options.redirects, 10) || 0, 0), 10);
    const timeout = parseInt(options.timeout, 10) || 8000;
    const protocol = String(options.protocol || '1.1'); // '1.1' | '2' | '3'
    const headers = {};
    if (options.referer) headers['Referer'] = String(options.referer);
    if (options.userAgent) headers['User-Agent'] = String(options.userAgent);
    else headers['User-Agent'] = 'Node-Proxy-NetTest/1.0';
    const body = method === 'POST' ? (options.body || '') : undefined;
    if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    if (protocol === '3') {
      throw new Error('HTTP/3：当前 Node.js 运行时不提供稳定的 HTTP/3(QUIC) 客户端，暂不支持');
    }

    const started = Date.now();
    let finalUrl = url;
    for (let hop = 0; hop <= redirects; hop++) {
      const outcome = await this._singleHttpProbe(finalUrl, { method, headers, body, timeout, protocol });
      if (outcome.redirect && hop < redirects) {
        finalUrl = new URL(outcome.redirect, finalUrl);
        continue;
      }
      if (outcome.redirect) {
        return { ok: true, ms: Math.round(Date.now() - started), status: outcome.status, size: outcome.size,
          speedKBps: Math.round((outcome.size / 1024) / Math.max((Date.now() - started) / 1000, 0.001)),
          detail: `重定向超限（>${redirects} 次）最终指向 ${finalUrl.host}${finalUrl.pathname}` };
      }
      const ms = Date.now() - started;
      return {
        ok: true,
        ms: Math.round(ms),
        status: outcome.status,
        size: outcome.size,
        speedKBps: Math.round((outcome.size / 1024) / Math.max(ms / 1000, 0.001)),
        detail: `${method} ${finalUrl.host}${finalUrl.pathname} → ${outcome.status}，${this._fmtBytes(outcome.size)}（限 1MB），${Math.round(ms)}ms`,
      };
    }
    throw new Error('Unexpected end of HTTP probe loop');
  }

  _singleHttpProbe(url, { method, headers, body, timeout, protocol }) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let status = 0;
      let done = false;
      const finish = (redirect) => {
        if (done) return;
        done = true;
        resolve({ size, status, redirect });
      };
      const fail = (err) => {
        if (done) return;
        done = true;
        reject(err);
      };

      if (protocol === '2' && url.protocol === 'https:') {
        // HTTP/2 over TLS (ALPN)
        const client = http2.connect(url.origin, { timeout });
        client.on('error', (e) => { try { client.destroy(); } catch (_) {} fail(e); });
        const req = client.request({
          ':method': method, ':path': url.pathname + url.search,
          'user-agent': headers['User-Agent'] || 'Node-Proxy-NetTest/1.0',
          ...(headers['Referer'] ? { referer: headers['Referer'] } : {}),
          ...(body !== undefined ? { 'content-type': headers['Content-Type'] } : {}),
        });
        req.on('response', (h) => {
          status = Number(h[':status']) || 0;
          if ([301, 302, 303, 307, 308].includes(status) && h.location) return finish(h.location);
        });
        req.on('data', (c) => {
          size += c.length;
          if (size > HTTP_BODY_LIMIT) { req.destroy(); finish(); }
        });
        req.on('end', () => finish());
        req.on('error', (e) => fail(e));
        if (body !== undefined) req.write(body);
        req.end();
        setTimeout(() => { try { req.destroy(); } catch (_) {} fail(new Error('HTTP/2 请求超时')); }, timeout);
        return;
      }

      // HTTP/1.1 (also the target when protocol=2 on plain http)
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
          timeout,
        },
        (res) => {
          status = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            return finish(res.headers.location);
          }
          res.on('data', (c) => {
            size += c.length;
            if (size > HTTP_BODY_LIMIT) {
              res.destroy();
              finish();
            }
          });
          res.on('end', () => finish());
          res.on('error', (e) => fail(e));
        }
      );
      req.on('error', (e) => fail(e));
      req.on('timeout', () => { req.destroy(); fail(new Error('请求超时')); });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  // --- DNS lookup ----------------------------------------------------------
  async _dnsLookup(target, options = {}) {
    const host = this._hostOf(target);
    const records = [];
    const types = (options.recordTypes && options.recordTypes.length
      ? options.recordTypes
      : ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']
    ).slice(0, 8);
    let failed = 0;
    for (const rtype of types) {
      const res = await new Promise((resolve2) => {
        const timer = setTimeout(() => resolve2({ type: rtype, timeout: true }), 2500);
        dnsPromises.resolve(host, rtype)
          .then((v) => { clearTimeout(timer); resolve2({ type: rtype, values: this._fmtRecords(rtype, v) }); })
          .catch((e) => { clearTimeout(timer); resolve2({ type: rtype, error: e.code || 'error' }); });
      });
      if (res.values) records.push({ type: rtype, values: res.values });
      else failed++;
    }
    if (!records.length) throw new Error(`DNS 查询无结果: ${host}`);
    return {
      ok: true,
      ms: 0,
      detail: records.map((r) => `${r.type}: ${r.values.join(', ')}`).join('\n'),
      extra: records,
      note: failed ? `${failed}/${types.length} 类型无记录` : '',
    };
  }

  _fmtRecords(type, values) {
    if (type === 'MX') return values.map((v) => `${v.exchange} (pri ${v.priority})`);
    if (type === 'CAA') return values.map((v) => `${v.issue ? 'issue=' + v.issue : ''}${v.issuemail ? 'iodef=' + v.issuemail : ''}`.trim());
    return (Array.isArray(values) ? values : [values]).map((v) => String(v));
  }

  // --- traceroute ----------------------------------------------------------
  async _traceroute(target, options = {}) {
    const { host } = this._hostPortOf(target, 443);
    if (!raw) {
      throw new Error('traceroute 需要 ICMP/UDP raw socket（npm raw-socket + root/CAP_NET_RAW）。当前不可用：' + (rawError || 'raw-socket 未安装'));
    }
    return this._udpTraceroute(host);
  }

  // UDP-based traceroute: probe each TTL sequentially, parse ICMP replies
  _udpTraceroute(host) {
    return new Promise((resolve, reject) => {
      require('dns').lookup(host, { family: 4 }, (err, addr) => {
        if (err) return reject(new Error('解析失败: ' + host));
        let icmp;
        let udp;
        try {
          icmp = raw.createSocket({ protocol: raw.Protocol.ICMP });
          udp = raw.createSocket({ protocol: raw.Protocol.UDP });
        } catch (e) {
          return reject(new Error('无法创建 raw socket: ' + e.message));
        }
        const destIp = addr;
        const basePort = 33434 + Math.floor(Math.random() * 1000);
        const perHopTimeout = 800;
        const hops = [];
        let ttl = 0;
        let curHop = null;
        let settled = false;
        let watchdog = setTimeout(() => done(), 25000);
        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          try { icmp.close(); } catch (_) {}
          try { udp.close(); } catch (_) {}
        };
        const done = () => {
          cleanup();
          resolve({ ok: true, detail: hops.map((h) => `${h.ttl}. ${h.ip || '*'}  ${h.ms != null ? h.ms + 'ms' : '超时'}`).join('\n'), hops });
        };

        const probeNext = () => {
          if (settled) return;
          ttl++;
          if (ttl > TRACEROUTE_MAX_HOPS) return done();
          const seq = (ttl * 64 + Math.floor(Math.random() * 200)) & 0xffff;
          const packet = Buffer.alloc(16);
          packet.writeUInt32BE(0xfeedface, 0);
          packet.writeUInt16BE(seq, 4);
          curHop = { ttl, ip: null, ms: null, seq };
          const started = Date.now();
          udp.send(packet, 0, packet.length, basePort + ttl, destIp, { ttl }, (err) => {
            if (err) { cleanup(); return reject(new Error('发送失败: ' + err.message)); }
          });
          const timer = setTimeout(() => {
            // timeout for this hop (no ICMP seen)
            curHop.ms = null;
            probeNext();
          }, perHopTimeout);
          const finishHop = (hopIp, reached) => {
            clearTimeout(timer);
            if (curHop && curHop.ttl === ttl) {
              curHop.ip = hopIp || null;
              curHop.ms = Math.round(Date.now() - started);
              if (reached || ttl >= TRACEROUTE_MAX_HOPS) return done();
              probeNext();
            }
          };
          icmp.once('message', (buffer, source) => {
            const hopIp = this._bufToIp(source) || this._bufToIp(buffer);
            const reached = buffer.length >= 8 && buffer.readUInt8(0) === 3 && buffer.readUInt8(1) === 3; // dest port unreachable
            finishHop(hopIp, reached);
          });
        };

        icmp.on('error', (e) => { cleanup(); reject(new Error('ICMP socket error: ' + e.message)); });
        udp.on('error', (e) => { cleanup(); reject(new Error('UDP socket error: ' + e.message)); });
        probeNext();
      });
    });
  }

  _bufToIp(buf) {
    if (!buf) return '';
    if (Buffer.isBuffer(buf)) {
      if (buf.length === 4) return [buf[0], buf[1], buf[2], buf[3]].join('.');
      if (buf.length === 16) {
        return Array.from(buf.subarray(0, 16)).join('.'); // best-effort (unlikely)
      }
      return String(buf);
    }
    return String(buf);
  }

  // --- helpers -------------------------------------------------------------
  _hostOf(target) {
    const urlMatch = /^[a-z]+:\/\//i.test(target) ? new URL(target) : null;
    if (urlMatch) return urlMatch.hostname;
    if (target.includes(':')) return target.split(':')[0];
    return target;
  }

  _hostPortOf(target, defPort) {
    if (/^[a-z]+:\/\//i.test(target)) {
      const u = new URL(target);
      return { host: u.hostname, port: parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80) };
    }
    const idx = target.lastIndexOf(':');
    if (idx > 0 && /^\d+$/.test(target.slice(idx + 1))) {
      return { host: target.slice(0, idx), port: parseInt(target.slice(idx + 1), 10) };
    }
    return { host: target, port: parseInt(defPort, 10) || 80 };
  }

  _fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { NetworkTestManager, MAX_TARGETS };
