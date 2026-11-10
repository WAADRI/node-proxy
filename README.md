# Node-Proxy (Go)

[![CI](https://github.com/WAADRI/node-proxy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/WAADRI/node-proxy/actions/workflows/ci.yml)

一个**多节点代理聚合网关**：把部署在公网的服务端和分布在各地、各网络环境的客户端节点组成一个代理池，对外提供统一的 HTTP / HTTPS / SOCKS5 代理出口，并通过 Web 面板集中管理节点和调整运行参数。

```
浏览器/应用 ──HTTP/SOCKS5──► 服务端（公网） ──按策略分发──► 客户端节点1/2/3...（各网络出口）
                                    │
                                    └── Web 面板：状态监控 + 运行设置
```

> Node.js 原版实现保留在 [`nodejs` 分支](https://github.com/WAADRI/node-proxy/tree/nodejs)。

## 特点

- **统一代理出口**：对外提供 HTTP / HTTPS CONNECT / SOCKS5 代理，多个客户端节点聚合成一个代理池，请求按策略（随机 / 最少负载 / 最快响应 / 加权）自动分发。
- **Web 管理面板**：实时查看节点在线状态、流量、熔断状态；管理节点标签、权重、别名/备注；**内置「运行设置」**，路由策略、熔断器阈值、带宽、客户端超时/并发等均可**在面板直接调整，保存即生效并持久化**，无需改配置文件或重启。
- **智能路由与容错**：熔断器自动隔离故障节点；心跳健康检查与断线自动重连。
- **权限与安全**：面板 JWT 登录；ACL 规则（源 IP、域名、端口、协议等多维匹配）；代理端口支持认证。
- **运维能力**：Prometheus 指标（`/metrics`）、结构化审计日志、ACME 自动证书、自更新（校验和验证 + 原子替换）、网络测试工具（Ping / TCPing / HTTP / DNS）。
- **中转流量压缩**：服务端与 Go 节点之间自动协商 zstd 逐帧压缩（可配置开关），可压缩内容最高 25 倍节省中转带宽；TS 节点自动不启用，完全向后兼容。
- **部署形态**：Docker Compose、systemd（Linux）、Windows 服务（WinSW）、单二进制免安装。

## 与 Node.js 版的差异

| | Go 版 | Node.js 版 |
|---|---|---|
| 部署 | **单二进制**（~10MB，面板已内嵌，免 Node.js） | 需要 Node.js/Bun 运行时 |
| 空载内存 | **~10 MB** | ~69 MB |
| 插件系统 | 无（不支持 .js 热加载） | 支持 |
| 中转压缩 | zstd（Go 节点自动协商） | 无 |
| 其余功能面 | 与 Node.js 版对齐 | — |

## 部署

### 1. 服务端（公网服务器，Docker 推荐）

前置：Docker 与 Docker Compose。

```bash
git clone https://github.com/WAADRI/node-proxy.git
cd node-proxy

# 必改：使用非默认的认证凭据（仓库公开，默认值人人皆知，务必覆盖）
export NP_AUTH_TOKEN='你的随机令牌'          # 客户端接入认证令牌
export NP_AUTH_WEB_USERNAME='admin'
export NP_AUTH_WEB_PASSWORD='你的强密码'      # 面板登录密码

docker compose -p node-proxy up -d
```

默认端口（如需改端口映射，编辑 `docker-compose.yml`）：

| 用途 | 端口 |
|------|------|
| Web 面板 | 3000 |
| HTTP / HTTPS 代理 | 8080 |
| SOCKS5 代理 | 1080 |

验证：浏览器打开 `http://服务器IP:3000`，用上面设置的账号登录。

不使用 Docker 时：

```bash
# 从 Releases 下载或自行构建
go build -o node-proxy-server ./cmd/node-proxy-server

NP_AUTH_TOKEN='你的随机令牌' \
NP_AUTH_WEB_USERNAME='admin' \
NP_AUTH_WEB_PASSWORD='你的强密码' \
./node-proxy-server
```

### 2. 客户端节点（内网 / 各地出口设备）

在每台要作为代理出口的机器上下载对应平台的二进制（**免安装，无需 Node.js**）：

```bash
# Windows x64
curl -L -o node-proxy-client.exe https://github.com/WAADRI/node-proxy/releases/latest/download/node-proxy-client-windows-amd64.exe
# Linux x64
curl -L -o node-proxy-client-linux-x64 https://github.com/WAADRI/node-proxy/releases/latest/download/node-proxy-client-linux-x64
# Linux arm64
curl -L -o node-proxy-client-linux-arm64 https://github.com/WAADRI/node-proxy/releases/latest/download/node-proxy-client-linux-arm64
chmod +x node-proxy-client-linux-x64
```

启动（环境变量方式，与配置文件等价）：

```bash
export SERVER_URL='ws://你的服务器域名或IP:3000/ws'   # 必填：服务端地址
export AUTH_TOKEN='你的随机令牌'                      # 必填：与服务端一致
export CLIENT_ID='my-node-1'                         # 可选：固定节点 ID
export TAGS='cn,unicom'                              # 可选：节点标签，用于按标签路由

./node-proxy-client
```

启动后日志出现认证成功即接入，服务端面板节点列表可见该节点。

也支持 `config.yaml` 文件方式（`server_url` / `auth_token` / `tags` / `region` 等字段，优先级 env > yaml > 默认）：

```bash
cp config.yaml.example config.yaml   # 按需填写
./node-proxy-client
```

不使用 Docker 时，同目录放一个 `config.yaml` 或直接环境变量启动即可（两者与上面等价）。

**Docker 方式**：

```bash
export SERVER_URL='ws://服务器:3000/ws'
export AUTH_TOKEN='你的令牌'
export CLIENT_ID='my-node-1'      # 可选，固定节点 ID

docker compose -f docker-compose.client.yml up -d
```

或直接拉 GHCR 镜像：

```bash
docker run -d --name node-proxy-client --restart unless-stopped   -e SERVER_URL='ws://服务器:3000/ws'   -e AUTH_TOKEN='你的令牌'   -e CLIENT_ID='my-node-1'   ghcr.io/waadri/node-proxy-client:latest
```

### 3. 使用与验证

浏览器或应用程序配置代理：

| 类型 | 地址 |
|------|------|
| HTTP / HTTPS | 服务器IP:8080 |
| SOCKS5 | 服务器IP:1080 |

面板中确认节点在线（数量 > 0）后，浏览器走上述代理即可正常上网。若启用了代理端口认证，按服务端配置的用户名/密码填写。

> 节点标签、路由策略、熔断阈值、带宽、超时/并发等运行参数都可在 Web 面板「系统设置」中直接管理，保存即生效。

## 配置

所有配置均支持三层覆盖：**环境变量 > config.yaml > 内置默认值**。

### 服务端

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `NP_AUTH_TOKEN` | 客户端接入令牌（必改） | — |
| `NP_AUTH_WEB_USERNAME` / `NP_AUTH_WEB_PASSWORD` | 面板登录凭据 | admin / — |
| `NP_WEB_PORT` | 面板端口 | 3000 |
| `NP_HTTP_PROXY_PORT` | HTTP 代理端口 | 8080 |
| `NP_SOCKS5_PORT` | SOCKS5 端口 | 1080 |
| `NP_COMPRESS_ENABLED` | 中转流量压缩 | true |
| `NP_ACME_DOMAINS` / `NP_ACME_EMAIL` | 面板 HTTPS（ACME 自动证书） | 关 |
| `NP_UPDATE_API_BASES` / `NP_UPDATE_DOWNLOAD_PREFIXES` | 自更新镜像加速（逗号分隔） | 官方源 |

### 客户端

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `SERVER_URL` | 服务端 WebSocket 地址 | ws://127.0.0.1:3000/ws |
| `AUTH_TOKEN` | 鉴权令牌 | — |
| `CLIENT_ID` / `CLIENT_ID_FILE` | 节点 ID（缺省自动生成并持久化） | 自动 |
| `REGION` / `TAGS` | 节点区域与标签 | 空 |
| `TLS_REJECT_UNAUTHORIZED` | 是否校验服务端证书 | true |
| `COMPRESS_ENABLED` | 中转流量压缩 | true |

> 心跳间隔、超时、并发上限等行为参数为固定内置值，不可配置——这是刻意设计，避免配置漂移导致节点行为不一致。

## 许可证

MIT
