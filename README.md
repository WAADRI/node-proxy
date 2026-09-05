# Node-Proxy

一个**多节点代理聚合网关**：把部署在公网的服务端和分布在各地、各网络环境的客户端节点组成一个代理池，对外提供统一的 HTTP / HTTPS / SOCKS5 代理出口，并通过 Web 面板集中管理节点和调整运行参数。

```
浏览器/应用 ──HTTP/SOCKS5──► 服务端（公网） ──按策略分发──► 客户端节点1/2/3...（各网络出口）
                                    │
                                    └── Web 面板：状态监控 + 运行设置
```

## 特点

- **统一代理出口**：对外提供 HTTP / HTTPS CONNECT / SOCKS5（含 UDP 中继）代理，多个客户端节点聚合成一个代理池，请求按策略自动分发。
- **Web 管理面板**：实时查看节点在线状态、流量、熔断状态；管理节点标签、权重、别名/备注；**内置「运行设置」**，路由策略、熔断器阈值、全局带宽、客户端超时/并发、缓存 TTL 等均可**在面板直接调整，保存即生效并持久化**，无需改配置文件或重启。
- **智能路由与容错**：随机 / 最少负载 / 最快响应 / 加权四种路由策略；熔断器自动隔离故障节点；健康检查与自动重连。
- **权限与安全**：面板 JWT 登录，admin / operator / viewer 三级角色权限；代理端口支持认证；ACL 规则（源 IP、域名、端口、协议、时间等多维匹配）。
- **运维能力**：结构化审计日志、Prometheus 指标 + Grafana 监控面板、SQLite 持久化、客户端自动更新、插件系统（.js/.mjs 热加载）、ACME 自动证书、WebSocket 流复用降低协议开销。
- **部署形态**：Docker Compose、systemd（Linux）、Windows 服务（WinSW）全覆盖。

## 部署

### 1. 服务端（公网服务器，Docker 推荐）

前置：Docker 与 Docker Compose。

```bash
git clone https://github.com/WAADRI/node-proxy.git
cd node-proxy/server

# 必改：使用非默认的认证凭据（仓库公开，默认值人人皆知，务必覆盖）
export NP_AUTH_TOKEN='你的随机令牌'          # 客户端接入认证令牌
export NP_AUTH_WEB_USERNAME='admin'
export NP_AUTH_WEB_PASSWORD='你的强密码'      # 面板登录密码

docker compose -p node-proxy up -d --build
```

> 构建镜像时会自动编译 Web 面板前端（`server/web`，Vue 3 + Vite），无需单独安装 Node.js。GitHub Actions 也会在每次推送时自动构建服务端镜像（tag：`master`）推送至腾讯云 CCR，供生产环境直接拉取。

默认端口（如需改端口映射，编辑 `server/docker-compose.yml`）：

| 用途 | 端口 |
|------|------|
| Web 面板 | 3000 |
| HTTP / HTTPS 代理 | 8080 |
| SOCKS5 代理 | 1080 |

验证：浏览器打开 `http://服务器IP:3000`，用上面设置的账号登录。

**nginx 反向代理（推荐）**：用域名 + HTTPS 反代 Web 面板，例如将 `https://proxy.example.com` 反向代理到本机 `:3000`（需透传 `X-Forwarded-For` 以便面板显示真实客户端 IP）。

不使用 Docker 时：

```bash
cd server && npm install
cp config.yaml config.local.yaml   # 按需修改
NP_CONFIG=config.local.yaml node server.js
# 开机自启：参考 server/deploy/ 下的 systemd 服务 / Windows 服务文件
```

### 2. 客户端节点（内网 / 各地出网设备，Docker 推荐）

在每台要作为代理出口的机器上执行：

```bash
git clone https://github.com/WAADRI/node-proxy.git   # 或直接拷贝 client/ 目录
cd node-proxy/client

export SERVER_URL='ws://你的服务器域名或IP:3000/ws'   # 必填：服务端地址
export AUTH_TOKEN='你的随机令牌'                      # 必填：与服务端 NP_AUTH_TOKEN 一致
export TAGS='region:cn,isp:unicom'                   # 可选：节点标签，用于按标签路由

docker compose -f docker-compose.client.yml up -d
```

不使用 Docker 时：

```bash
cd client && npm install
SERVER_URL='ws://服务器:3000/ws' AUTH_TOKEN='你的令牌' TAGS='region:cn' npm start
```

**免安装二进制版**（无需 Node.js 环境）：本仓库不做语义化版本号，二进制为**持续更新的 `dev` 构建**——每次推送到 `main` 都会删除旧发布并用本次构建重建 [GitHub Releases](https://github.com/WAADRI/node-proxy/releases) 的 Latest。按平台下载 `client-*`（Windows x64 / Linux x64 / Linux arm64），可用下面固定链接直取最新构建：

```bash
# Windows x64
curl -L -o node-proxy-client.exe https://github.com/WAADRI/node-proxy/releases/latest/download/client-win-x64.exe
# Linux x64
curl -L -o node-proxy-client-linux-x64 https://github.com/WAADRI/node-proxy/releases/latest/download/client-linux-x64
# Linux arm64
curl -L -o node-proxy-client-linux-arm64 https://github.com/WAADRI/node-proxy/releases/latest/download/client-linux-arm64
```

在文件旁放一个 `config.yaml` 或直接用环境变量启动（两者均与 Node.js 版完全一致）：

```bash
# 方式一：旁边放 config.yaml（server_url / auth_token / tags / region 等字段同 client/config.yaml）
./node-proxy-client-linux-x64

# 方式二：环境变量
SERVER_URL='ws://服务器:3000/ws' AUTH_TOKEN='你的令牌' TAGS='region:cn' ./node-proxy-client-linux-x64
```

Windows 双击或命令行直接运行即可；注册成功同样会打印 `Registered with ID: ...`，可作为 Windows 服务（WinSW）的程序路径。因为每次 main 提交都会重建发布，机器上已下载的旧版本可随时重新下载覆盖更新。

启动后日志出现 `Registered with ID: ...` 即接入成功，随后可在服务端面板的节点列表看到该节点。如需固定节点 ID（避免容器重建后 ID 变化），可设置 `CLIENT_ID` 环境变量。

### 3. 使用与验证

浏览器或应用程序配置代理：

| 类型 | 地址 |
|------|------|
| HTTP / HTTPS | 服务器IP:8080 |
| SOCKS5 | 服务器IP:1080 |

面板中确认节点在线（数量 > 0）后，浏览器走上述代理即可正常上网。若启用了代理端口认证，按服务端配置的用户名/密码填写。

> 节点标签、域名规则、ACL、每节点限速/权重、以及各种运行参数（路由策略、熔断、带宽、超时、缓存）都可在 Web 面板中直接管理，无需改文件；仅端口、认证令牌等启动级参数通过环境变量或 `config.yaml` 修改。

## 许可证

MIT
