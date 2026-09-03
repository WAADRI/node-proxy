# Node-Proxy

分布式 IP 代理系统 —— 让无公网 IP 的客户端节点通过公网服务器提供 HTTP/HTTPS/SOCKS5 代理服务。

**版本：** 3.0.0 | **许可证：** MIT

---

## 目录

- [架构](#架构)
- [功能总览](#功能总览)
- [快速开始](#快速开始)
- [客户端使用指南](#客户端使用指南)
- [配置](#配置)
- [API 文档](#api-文档)
- [部署](#部署)
- [监控](#监控)
- [安全](#安全)
- [开发](#开发)

---

## 架构

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                             公网服务器 (Server)                                    │
│                                                                                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐                │
│  │  Web 控制面板 :3000  │  │ HTTP 代理 :8080    │  │ SOCKS5 :1080      │                │
│  │  + Swagger 文档    │  │ (+ HTTPS CONNECT)  │  │ (+ UDP ASSOCIATE)  │                │
│  │  + Prometheus 指标 │  │                    │  │                    │                │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘                │
│           │                     │                     │                            │
│           └─────────────────────┼─────────────────────┘                            │
│                                 │                                                  │
│                         ┌───────▼────────┐                                        │
│                         │   Client Manager │                                        │
│                         │   (StreamMux)    │  ← 流复用 + 优先级 + 流控              │
│                         │   + 路由 + 熔断器  │                                        │
│                         │   + 带宽 + 缓存   │                                        │
│                         └───────┬────────┘                                        │
│                                 │ ws://host:3000/ws                                │
│                                 │ (二进制协议 / JSON 双模式)                        │
└─────────────────────────────────┼──────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
               ┌────▼───┐   ┌────▼───┐   ┌────▼───┐
               │Client A│   │Client B│   │Client C│  ...
               │(无公网IP)│   │(无公网IP)│   │(无公网IP)│
               │ 标签:  │   │ 标签:  │   │ 标签:  │
               │ region:cn│  │ region:us│  │ region:eu│
               └────────┘   └────────┘   └────────┘
```

### 工作原理

1. **客户端**（无公网 IP）主动通过 WebSocket 连接到**服务端**（公网 IP）
2. **服务端**维护所有在线客户端列表，每个客户端可携带标签（tag）
3. 用户通过服务端开放的代理端口发送请求
4. 服务端根据**路由策略**选择一个在线客户端，通过 WebSocket 流复用转发请求
5. 客户端执行实际的网络请求，将结果返回给服务端
6. 服务端将结果返回给原始请求方

---

## 功能总览

### Phase 1 — 基础加固（MVP → 可用）✅

| 功能 | 说明 |
|------|------|
| **TLS 加密** | 支持 wss:// + HTTPS，自动生成自签名证书 |
| **代理端口认证** | HTTP Basic Auth + SOCKS5 RFC 1929 用户名/密码认证 |
| **Web 面板登录** | JWT 令牌认证，支持 Bearer Token 和 Cookie |
| **健康检查** | 心跳超时自动剔除，10 秒间隔 |
| **结构化日志** | Pino 日志系统，支持文件轮转、pretty 打印 |
| **YAML 配置** | 支持 `config.yaml` + `NP_` 环境变量 + `--cli` 参数三层覆盖 |

### Phase 2 — 运营增强（可用 → 可靠）✅

| 功能 | 说明 |
|------|------|
| **节点标签分组** | 客户端通过 `tags` 配置标签，服务端按标签路由 |
| **多路由策略** | 随机 / 最小负载 / 最快响应 / 加权轮询 |
| **流量统计 + 带宽限制** | 令牌桶算法，按全局或客户端限速 |
| **熔断器** | 自动隔离故障节点，三态：CLOSED → OPEN → HALF_OPEN |
| **Prometheus 指标** | 请求量、延迟、错误率、节点状态等指标，Grafana 面板 |
| **Docker 部署** | 多阶段构建，Prometheus + Grafana 一键编排 |
| **SQLite 持久化** | 客户端事件、流量统计、配置覆盖持久化存储 |

### Phase 3 — 高级功能（可靠 → 强大）✅

| 功能 | 说明 |
|------|------|
| **多用户 RBAC** | admin / operator / viewer 三级角色，细粒度权限控制 |
| **域名规则引擎** | 通配符域名匹配 → 路由到指定标签组，支持优先级排序 |
| **请求缓存 + 去重** | 内存缓存（TTL 5s），相同 URL 并发请求自动合并 |
| **SOCKS5 UDP ASSOCIATE** | 完整 UDP 中继，支持 IPv4/IPv6/域名地址解析 |
| **IPv6 双栈** | 服务端绑定 `::` 双栈地址，支持 IPv6-only 模式 |
| **二进制协议** | 高效的二进制帧格式替代 JSON+Base64，降低 95% 协议开销 |
| **ACL 规则引擎** | 源IP/CIDR、目标域名、端口范围、协议、时间、标签多维度匹配 |
| **请求审计日志** | 结构化 JSON 日志，自动轮转，支持 API 查询 |
| **插件系统** | 热加载 .js/.mjs 插件，支持 onRequest/onResponse 等钩子 |
| **ACME 自动证书** | Let's Encrypt 自动签发，HTTP-01 挑战，到期自动续签 |
| **Swagger 文档** | 32 个 API 路径，交互式文档界面 |
| **客户端自动更新** | 版本检查、下载、SHA256 校验、自动部署 |
| **systemd / Windows 服务** | 官方服务文件，生产级部署支持 |

### Phase 4 — 生产级（强大 → 企业）✅

| 功能 | 说明 |
|------|------|
| **WebSocket 流复用** | HTTP/2 风格流复用，优先级调度，窗口流控，背压机制 |

---

## 快速开始

### 1. 服务端部署（公网服务器）

```bash
# 安装依赖
cd server
npm install

# 创建配置文件
cp config.yaml config.local.yaml
# 编辑 config.local.yaml 修改认证令牌

# 启动服务端
NP_CONFIG=config.local.yaml node server.js

# 或使用环境变量快速启动
AUTH_TOKEN=my-secret-token node server.js --logging-pretty
```

### 2. 客户端部署（内网节点）

```bash
# 安装依赖
cd client
npm install

# 方式一：环境变量配置
export SERVER_URL=ws://你的服务器IP:3000/ws
export AUTH_TOKEN=my-secret-token
export TAGS="region:cn,isp:unicom"

# 启动客户端
npm start
```

客户端连接成功后，日志会显示：

```
[2026-09-01T10:00:00.000Z] [INFO] Connecting to ws://你的服务器IP:3000/ws ...
[2026-09-01T10:00:01.000Z] [INFO] Connected to server
[2026-09-01T10:00:01.000Z] [INFO] Authentication successful
[2026-09-01T10:00:01.000Z] [INFO] Registered with ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

看到 `Registered with ID` 即表示节点已成功接入服务端。此时打开 `http://服务器IP:3000` 控制面板，可以看到该节点出现在客户端列表中。

> 详细配置方式（配置文件、标签路由、开机自启等）见下文 [客户端使用指南](#客户端使用指南)。

### 3. 使用代理

配置你的浏览器或应用程序：

| 类型 | 地址 | 端口 |
|------|------|------|
| HTTP | 服务器 IP | 8080 |
| HTTPS | 服务器 IP | 8080 |
| SOCKS5 | 服务器 IP | 1080 |

**认证（可选）：** 如果启用了代理认证，配置用户名 `proxy` 和密码 `proxy-pass`（⚠ 启用前务必修改默认密码，默认值已在公开文档中列出）。

---

## 客户端使用指南

### 客户端是什么

客户端是运行在**无公网 IP 的机器**上的轻量级程序（`client/client.js`），它：

1. 主动通过 WebSocket 连接服务端（出站连接，无需公网 IP、无需端口映射）
2. 注册自身信息（主机名、IP、系统、标签等）
3. 接收服务端转发的 HTTP 请求 / TCP 隧道请求，代为访问目标网站并返回结果

一台客户端即一个"出口节点"。部署的节点越多、分布越广，可用的出口 IP 越丰富。

### 安装

```bash
cd client
npm install        # 只需 ws 一个依赖
```

### 配置方式

客户端支持两种配置方式（**配置文件优先于环境变量**）：

#### 方式一：配置文件 `config.yaml`

在 `client/` 目录下创建 `config.yaml`（或 `config.yml`）：

```yaml
# client/config.yaml
server_url: ws://你的服务器IP:3000/ws
auth_token: my-secret-token   # ⚠ 改成你自己的强随机值（勿用默认值）

# 可选配置
region: cn                     # 区域标识（展示用）
tags: "region:cn,isp:unicom"   # 节点标签，逗号分隔
reconnect_delay: 3000          # 重连初始延迟（毫秒）
max_reconnect_delay: 30000     # 最大重连延迟（毫秒）
heartbeat_interval: 15000      # 心跳间隔（毫秒）
request_timeout: 30000         # HTTP 请求超时（毫秒）
tunnel_timeout: 30000          # TCP 隧道超时（毫秒）
max_concurrent_requests: 100   # 最大并发请求数
tls_reject_unauthorized: false # wss 连接是否校验证书
```

也可以通过 `CONFIG_PATH` 环境变量指定配置文件路径：

```bash
CONFIG_PATH=/etc/node-proxy-client/config.yaml node client.js
```

#### 方式二：环境变量

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `SERVER_URL` | `ws://127.0.0.1:3000/ws` | 服务端 WebSocket 地址（必填） |
| `AUTH_TOKEN` | `node-proxy-default-token` | 认证令牌，必须与服务端 `auth.token` 一致；⚠ 默认值已公开，生产必须修改 |
| `REGION` / `NODE_REGION` | `unknown` | 节点区域标识 |
| `TAGS` | `""` | 节点标签，逗号分隔 |
| `RECONNECT_DELAY` | `3000` | 重连初始延迟（毫秒） |
| `MAX_RECONNECT_DELAY` | `30000` | 最大重连延迟（毫秒） |
| `HEARTBEAT_INTERVAL` | `15000` | 心跳间隔（毫秒） |
| `REQUEST_TIMEOUT` | `30000` | HTTP 请求超时（毫秒） |
| `TUNNEL_TIMEOUT` | `30000` | TCP 隧道建立超时（毫秒） |
| `MAX_CONCURRENT_REQUESTS` | `100` | 最大并发请求数 |
| `TLS_REJECT_UNAUTHORIZED` | `false` | 是否校验服务端 wss 证书 |
| `CLIENT_ID_FILE` | `~/.node-proxy-client-id` | 客户端稳定 ID 存储文件路径（多实例主机请为每个实例指定不同路径） |

> **节点元数据持久化**：客户端启动时会生成并持久化一个稳定 `clientId`（默认保存在 `~/.node-proxy-client-id`），服务端据此在客户端重连/重启后自动恢复该节点的**权重（weight）、标签（tags）和带宽限制**。Docker 部署时该文件位于容器内，容器重建后 ID 会变化；如需跨容器保留，请将 `CLIENT_ID_FILE` 指向挂载卷路径。

### 节点标签（Tags）与路由

标签是节点的分组标识，用于服务端的**按标签路由**和**域名规则路由**：

```bash
# 启动时指定标签
export TAGS="region:cn,isp:unicom,role:video"
npm start
```

标签是逗号分隔的键值对字符串，服务端会将其解析为数组。结合服务端配置：

```yaml
# 服务端 config.yaml
domain_rules:
  - pattern: "*.xuexitong.com"   # 超星学习通流量
    tag: "region:cn"             # 只路由到 cn 区域节点
    priority: 10
  - pattern: "*.google.com"
    tag: "role:video"
    priority: 20
```

这样不同域名的流量会自动路由到带对应标签的节点组。详见服务端 [配置](#配置) 章节。

### 启动与验证

```bash
npm start
```

启动后日志输出：

```
========================================
  Node-Proxy Client v2.1
========================================
  Server: ws://你的服务器IP:3000/ws
  Hostname: my-node
  Platform: win32 x64
  Region: cn
  Concurrency: 100
========================================
[2026-09-01T10:00:00.000Z] [INFO] Connecting to ws://你的服务器IP:3000/ws ...
[2026-09-01T10:00:01.000Z] [INFO] Connected to server
[2026-09-01T10:00:01.000Z] [INFO] Authentication successful
[2026-09-01T10:00:01.000Z] [INFO] Registered with ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

验证节点是否生效：

1. **服务端控制面板**：打开 `http://服务器IP:3000`，客户端列表中应显示该节点（主机名、IP、标签、在线状态）
2. **实际测试代理**：用代理访问 `http://httpbin.org/ip`，返回的 `origin` IP 应是节点所在网络的出口 IP
3. **API 查询**：`curl http://服务器IP:3000/api/v1/status` 查看 `clients` 数组

### 守护进程运行

#### Linux（systemd）

创建 `/etc/systemd/system/node-proxy-client.service`：

```ini
[Unit]
Description=Node-Proxy Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/node-proxy/client
ExecStart=/usr/bin/node /opt/node-proxy/client/client.js
Restart=always
RestartSec=10
Environment=SERVER_URL=ws://你的服务器IP:3000/ws
Environment=AUTH_TOKEN=my-secret-token
Environment=TAGS=region:cn

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable node-proxy-client
sudo systemctl start node-proxy-client
```

#### Windows（计划任务 / NSSM）

使用 NSSM（Non-Sucking Service Manager）注册为系统服务：

```bat
nssm install NodeProxyClient "C:\Program Files\nodejs\node.exe" "C:\node-proxy\client\client.js"
nssm set NodeProxyClient AppEnvironmentExtra SERVER_URL=ws://你的服务器IP:3000/ws AUTH_TOKEN=my-secret-token TAGS=region:cn
nssm set NodeProxyClient AppStdout C:\node-proxy\client\client.log
nssm set NodeProxyClient AppStderr C:\node-proxy\client\client.err.log
nssm set NodeProxyClient Start SERVICE_AUTO_START
nssm start NodeProxyClient
```

#### Docker

客户端已内置 `Dockerfile` 与 `docker-compose.client.yml`，支持一键容器化部署。

**方式一：docker compose（推荐）**

在内网节点机器上（`client/` 目录）：

```bash
# 构建并启动
SERVER_URL=ws://你的服务器IP:3000/ws AUTH_TOKEN=my-secret-token TAGS="region:cn" \
  docker compose -f docker-compose.client.yml up -d

# 查看日志
docker logs -f node-proxy-client

# 停止 / 重启
docker compose -f docker-compose.client.yml down
docker compose -f docker-compose.client.yml restart
```

**方式二：docker run**

```bash
docker run -d --restart=always --name node-proxy-client \
  -e SERVER_URL=ws://你的服务器IP:3000/ws \
  -e AUTH_TOKEN=my-secret-token \
  -e REGION=cn \
  -e TAGS=region:cn \
  node-proxy-client:latest
```

**常用环境变量**（完整列表见下方「环境变量速查」）：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SERVER_URL` | ✅ | `ws://127.0.0.1:3000/ws` | 服务端 WebSocket 地址，**必须修改** |
| `AUTH_TOKEN` | ✅ | `node-proxy-default-token` | 认证令牌，需与服务端一致；⚠ 默认值已公开，生产必须修改 |
| `TAGS` | - | 空 | 节点标签，逗号分隔（如 `region:cn,isp:unicom`） |
| `REGION` | - | `unknown` | 区域标识 |
| `RECONNECT_DELAY` | - | `3000` | 重连初始延迟(ms) |
| `MAX_RECONNECT_DELAY` | - | `30000` | 最大重连延迟(ms) |
| `TLS_REJECT_UNAUTHORIZED` | - | `false` | 是否校验服务端 TLS 证书 |
| `CLIENT_ID_FILE` | - | `/root/.node-proxy-client-id` | 客户端稳定 ID 文件；跨容器重建保留权重/标签/限速时，改为挂载卷路径（如 `/data/node-proxy-client-id`） |

**挂载配置文件（可选）**：把 `config.yaml` 放到 `client/` 目录即可被自动挂载（`./config.yaml:/app/config.yaml:ro`），文件配置会被环境变量覆盖。配置项见「客户端配置」一节。

> 提示：客户端镜像会执行 `npm install --omit=dev` 仅安装运行时依赖（`ws`、`js-yaml`），以非 root 用户运行，适合直接放入生产节点。

### 多节点部署

内网有多台机器时，每台都运行一个客户端即可（每台需要独立的网络出口才有效果）：

```bash
# 节点 1（电信宽带）
SERVER_URL=ws://server:3000/ws TAGS="region:cn,isp:telecom" node client.js

# 节点 2（联通宽带）
SERVER_URL=ws://server:3000/ws TAGS="region:cn,isp:unicom" node client.js

# 节点 3（美国 VPS）
SERVER_URL=ws://server:3000/ws TAGS="region:us,isp:aws" node client.js
```

服务端会根据路由策略（随机 / 最小负载 / 最快响应 / 加权）在在线节点间分配流量。

### 常见问题排查

| 现象 | 原因 | 解决办法 |
|------|------|----------|
| `Authentication failed` | 令牌与服务端不一致 | 确认 `AUTH_TOKEN` 与服务端 `auth.token` 相同 |
| 一直 `Reconnecting` | 网络不通 / 服务端未启动 | 检查 `SERVER_URL` 是否正确、服务端 3000 端口是否可达、防火墙是否放行 |
| 连接成功但节点不在面板 | 未完成注册 | 检查服务端日志中的 `Client registered` 记录 |
| 请求全部超时 | 节点网络异常或并发超限 | 检查节点本地网络；调大 `max_concurrent_requests` |
| wss 连接报证书错误 | 自签名证书未信任 | 保持 `tls_reject_unauthorized: false`（默认） |

---

## 配置

### 三层配置优先级

```
config.yaml  <  NP_ 环境变量  <  --cli 参数
```

示例：
```bash
# 三种方式等效
NP_AUTH_TOKEN=secret node server.js
node server.js --auth-token secret
# 修改 config.yaml 中的 auth.token
```

### 完整配置参考

```yaml
server:
  host: 0.0.0.0          # 监听地址（0.0.0.0=IPv4, ::=双栈）
  web_port: 3000          # Web 控制面板端口
  http_proxy_port: 8080   # HTTP 代理端口
  socks5_port: 1080       # SOCKS5 代理端口
  ipv6_only: false        # IPv6-only 模式

auth:
  token: node-proxy-default-token  # ⚠ 客户端连接令牌：默认值已公开，生产必须修改
  proxy:
    enabled: false
    username: proxy
    password: proxy-pass            # ⚠ 启用代理认证前必须修改
  web:
    enabled: true
    username: admin                 # ⚠ 生产建议更换默认用户名
    password: admin123              # ⚠ Web 管理员密码：默认值已公开，生产必须修改
    jwt_secret: ""                  # 留空自动生成
  users:
    - username: operator1           # ⚠ 示例用户，生产请删除或改强密码
      password: op-pass
      role: operator
    - username: viewer1
      password: viewer-pass
      role: viewer

client:
  request_timeout: 30000   # HTTP 请求超时（毫秒）
  tunnel_timeout: 15000    # TCP 隧道建立超时
  max_concurrent: 100      # 每客户端最大并发请求数
  health_check_interval: 10000  # 健康检查间隔

router:
  strategy: random         # 路由策略：random/least-loaded/fastest-response/weighted

circuit_breaker:
  enabled: true
  failure_threshold: 5     # 连续失败次数触发熔断
  success_threshold: 3     # 半开后成功次数恢复
  open_timeout: 30000      # 熔断持续时间（毫秒）

bandwidth:
  enabled: false
  global_limit: 10485760   # 全局带宽限制（字节/秒）
  per_client_limit: 1048576  # 每客户端限制

cache:
  enabled: true
  default_ttl: 5000        # 默认缓存时间（毫秒）
  max_size: 5000           # 最大缓存条目数
  max_body_size: 1048576   # 最大缓存体大小（字节）

domain_rules:
  - pattern: "*.example.com"
    tag: "region:cn"
    priority: 10
  - pattern: "api.example.com"
    tag: "region:us"
    priority: 20

acl:
  enabled: true
  rules:
    - action: deny
      priority: 100
      description: "Block private networks"
      match:
        targetIp: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    - action: deny
      priority: 50
      description: "Block social media"
      match:
        targetDomain: "*.facebook.com,*.twitter.com"
        time: { start: "09:00", end: "18:00" }

audit:
  enabled: true
  dir: "./audit"
  max_size: 52428800       # 50MB 轮转
  max_files: 5

mux:
  initial_window: 65536    # 每流初始窗口 64KB
  connection_window: 1048576  # 连接窗口 1MB
  max_frame_size: 16384    # 每帧最大 16KB

acme:
  enabled: false
  email: "admin@example.com"
  staging: true
  domains: ["proxy.example.com"]

plugins:
  dir: "./plugins"
  auto_load: true

update:
  enabled: false
  url: "https://update.example.com/check"
  dir: "./updates"

logging:
  level: info
  pretty: false
  dir: "./logs"
  max_size: 10485760       # 10MB
  max_files: 5
```

### 环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NP_AUTH_TOKEN` | `node-proxy-default-token` | 客户端认证令牌；⚠ 默认值已公开，生产必须修改 |
| `NP_AUTH_PROXY_ENABLED` | `false` | 启用代理端口认证 |
| `NP_AUTH_WEB_ENABLED` | `true` | 启用 Web 面板认证 |
| `NP_AUTH_WEB_USERNAME` | `admin` | Web 管理员用户名；⚠ 生产建议更换 |
| `NP_AUTH_WEB_PASSWORD` | `admin123` | Web 管理员密码；⚠ 默认值已公开，生产必须修改 |
| `NP_SERVER_HOST` | `0.0.0.0` | 监听地址 |
| `NP_SERVER_WEB_PORT` | `3000` | Web 面板端口 |
| `NP_ROUTER_STRATEGY` | `random` | 路由策略 |
| `NP_LOGGING_LEVEL` | `info` | 日志级别 |
| `NP_LOGGING_PRETTY` | `false` | 美化日志输出 |
| `NP_CACHE_ENABLED` | `true` | 启用缓存 |
| `NP_ACL_ENABLED` | `true` | 启用 ACL |
| `NP_AUDIT_ENABLED` | `true` | 启用审计日志 |

---

## API 文档

启动服务后访问 `http://服务器IP:3000/api/docs` 查看交互式 Swagger 文档。

### 核心 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/status` | 系统状态概览 |
| GET | `/api/v1/config` | 当前配置 |
| GET | `/api/v1/clients` | 客户端列表 |
| POST | `/api/v1/clients/:id/kick` | 踢出客户端 |
| GET | `/api/v1/users` | 用户列表 |
| POST | `/api/v1/users` | 创建用户 |
| DELETE | `/api/v1/users/:username` | 删除用户 |
| GET | `/api/v1/domain-rules` | 域名规则列表 |
| POST | `/api/v1/domain-rules` | 添加域名规则 |
| GET | `/api/v1/cache/stats` | 缓存统计 |
| POST | `/api/v1/cache/clear` | 清除缓存 |
| GET | `/api/v1/plugins` | 插件列表 |
| POST | `/api/v1/plugins/:name/install` | 安装插件 |
| DELETE | `/api/v1/plugins/:name` | 卸载插件 |
| GET | `/api/v1/circuit-breaker/status` | 熔断器状态 |
| POST | `/api/v1/circuit-breaker/reset` | 重置熔断器 |
| GET | `/api/v1/acl/rules` | ACL 规则列表 |
| POST | `/api/v1/acl/rules` | 添加 ACL 规则 |
| GET | `/api/v1/acl/stats` | ACL 统计 |
| GET | `/api/v1/audit/query` | 审计日志查询 |
| GET | `/api/v1/audit/stats` | 审计日志统计 |
| GET | `/api/v1/update/status` | 自动更新状态 |
| POST | `/api/v1/update/check` | 触发更新检查 |
| GET | `/api/v1/mux/stats` | 流复用统计 |
| GET | `/metrics` | Prometheus 指标 |

---

## 部署

### Docker 部署

```bash
# 构建并启动
docker compose up -d

# 使用监控模式（含 Prometheus + Grafana）
docker compose --profile monitoring up -d
```

### systemd（Linux）

```bash
# 安装
sudo cp deploy/node-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable node-proxy
sudo systemctl start node-proxy

# 查看状态
sudo systemctl status node-proxy
```

### Windows 服务

```bash
# 安装 WinSW
# 下载 winsw.exe 到 bin/ 目录

# 安装服务
deploy\install-service.bat install

# 启动
deploy\install-service.bat start
```

---

## 监控

### Prometheus 指标

| 指标 | 类型 | 说明 |
|------|------|------|
| `node_proxy_requests_total` | Counter | 总请求数 |
| `node_proxy_request_duration_seconds` | Histogram | 请求延迟分布 |
| `node_proxy_active_tunnels` | Gauge | 活跃隧道数 |
| `node_proxy_pending_requests` | Gauge | 待处理请求数 |
| `node_proxy_clients_online` | Gauge | 在线客户端数 |
| `node_proxy_errors_total` | Counter | 错误总数 |
| `node_proxy_bandwidth_bytes` | Counter | 流量统计 |
| `node_proxy_circuit_breaker_state` | Gauge | 熔断器状态 |

### Grafana 面板

Docker 部署时默认包含 Grafana，访问 `http://服务器IP:3001`（默认账号 admin/admin）。

---

## 安全

> ⚠️ **重要：本仓库为公开仓库，以下默认凭据公开可见。任何环境（尤其是公网部署）使用前都必须修改，否则任何人都可以用默认值连接你的代理、或登录你的控制面板：**

| 默认凭据 | 用途 | 处理方式 |
|----------|------|----------|
| `node-proxy-default-token` | 客户端连接认证（`auth.token` / `NP_AUTH_TOKEN`） | 必须改为强随机字符串 |
| `admin` / `admin123` | Web 控制面板管理员（`auth.web` / `NP_AUTH_WEB_*`） | 必须改为独立强密码，建议同时更换用户名 |
| `proxy` / `proxy-pass` | 代理端口认证（`auth.proxy`） | 默认未启用；启用前必须修改 |
| `operator1` / `op-pass`、`viewer1` / `viewer-pass` | 预置用户示例 | 删除或改为强密码 |

部署建议：

1. 务必修改 `AUTH_TOKEN`（服务端 `auth.token`）为强随机值，防止未授权客户端接入
2. 修改 Web 面板默认密码 `admin123`、默认用户名 `admin`（`NP_AUTH_WEB_USERNAME` / `NP_AUTH_WEB_PASSWORD`）
3. 代理端口默认监听所有网络接口，建议使用防火墙限制访问
4. 生产环境建议在 Web 面板前添加反向代理并配置 HTTPS
5. 使用 ACL 规则限制私有网络访问和敏感域名
6. 启用审计日志记录所有代理请求，便于事后追溯
7. 定期轮换 Web 面板密码和 JWT 密钥

---

## 开发

```bash
# 服务端开发模式
cd server
npm run dev   # 使用 --watch 自动重启

# 查看日志
tail -f server.log

# 查看审计日志
tail -f audit/audit.log | jq .

# 调试模式启动
NP_LOGGING_LEVEL=debug NP_LOGGING_PRETTY=true node server.js
```

### 项目结构

```
node-proxy/
├── server/                  # 服务端
│   ├── server.js           # 入口文件
│   ├── config.yaml         # 默认配置
│   ├── lib/
│   │   ├── config.js       # 配置加载器（YAML + env + CLI）
│   │   ├── logger.js       # Pino 日志系统
│   │   ├── auth.js         # RBAC 多用户认证
│   │   ├── tls.js          # TLS/SSL 证书管理
│   │   ├── client-manager.js  # 客户端注册中心
│   │   ├── proxy-http.js   # HTTP/HTTPS 代理
│   │   ├── proxy-socks5.js # SOCKS5 代理（含 UDP ASSOCIATE）
│   │   ├── ws-server.js    # WebSocket 服务器（StreamMux 集成）
│   │   ├── web-server.js   # Express Web 面板
│   │   ├── router.js       # 路由策略引擎
│   │   ├── circuit-breaker.js  # 熔断器
│   │   ├── bandwidth.js    # 带宽限制器
│   │   ├── storage.js      # SQLite 持久化
│   │   ├── metrics.js      # Prometheus 指标
│   │   ├── domain-router.js  # 域名路由引擎
│   │   ├── cache.js        # 请求缓存 + 去重
│   │   ├── plugin-manager.js  # 插件系统
│   │   ├── acme.js         # Let's Encrypt 自动证书
│   │   ├── swagger.js      # Swagger/OpenAPI 文档
│   │   ├── acl.js          # ACL 规则引擎
│   │   ├── audit.js        # 审计日志
│   │   ├── auto-update.js  # 自动更新
│   │   ├── binary-protocol.js  # 二进制协议
│   │   └── stream-mux.js   # WebSocket 流复用
│   ├── public/             # 前端静态资源
│   ├── views/              # HTML 模板
│   ├── plugins/            # 插件目录
│   └── deploy/             # 部署文件
├── client/                 # 客户端
│   ├── client.js           # 客户端入口（配置加载、重连、请求/隧道处理）
│   ├── config.yaml         # 客户端配置（可选，见"客户端使用指南"）
│   ├── package.json        # 依赖（ws + js-yaml）
│   ├── lib/
│   │   └── stream-mux.js   # WebSocket 流复用（客户端侧）
│   ├── Dockerfile          # 客户端 Docker 镜像
│   ├── docker-compose.client.yml  # 客户端 Docker 编排
│   └── .dockerignore       # 构建排除项
├── deploy/
│   ├── node-proxy.service  # systemd 服务文件
│   ├── node-proxy.xml      # WinSW 服务配置
│   └── install-service.bat  # Windows 服务安装脚本
├── docker-compose.yml      # Docker 编排
├── Dockerfile              # Docker 构建
└── prometheus.yml          # Prometheus 配置
```

---

## 许可证

MIT