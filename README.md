# node-proxy-go

[![CI](https://github.com/WAADRI/node-proxy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/WAADRI/node-proxy/actions/workflows/ci.yml)

github.com/WAADRI/node-proxy（Node/TS 多节点代理聚合网关）的 Go 重写。
> Node.js 原版实现保留在本仓库的 [`nodejs` 分支](https://github.com/WAADRI/node-proxy/tree/nodejs)。

既定方针：**客户端先行、协议字节级兼容、strangler 渐进迁移**。不做插件系统，运行时唯一
动态变更是配置热重载（沿用面板白名单 + SQLite overrides 模式）。

## 当前进度

- [x] StreamMux 帧协议 wire codec（`internal/streammux`）——**已通过与 TS 端字节级一致性测试**
- [x] StreamMux 会话层（session.go / stream.go / transport.go）——含 JSON 文本控制面（SendText/OnText，
      认证/心跳/统计与 mux 帧共享同一 FIFO，与 TS 发送顺序语义一致）
- [x] WebSocket Transport 适配器（`internal/wstransport`，gorilla/websocket）
- [x] **Go ↔ TS 活体互操作**（`internal/interop`）——mux 级四场景 + 客户端全流程
- [x] **Go 客户端核心**（`internal/client`）——TS 协议完整对齐：
      token 认证（文本帧）→ auth_ok 后上报身份（hostname/platform/clientId/supportsMux/region/tags）→
      心跳（JSON heartbeat+stats + mux 级 PING，3 次无 PONG 强制重连）→ `limits` 并发限额（校验 1..100000）→
      TUNNEL_OPEN 拨号真实目标 + 双向管道（tunnel_ready/tunnel_error 应答、12s 建连超时、5s FIN 后强杀）→
      断线重连（3s×1.5^n+jitter，上限 30s）。认证前拒绝一切 mux 流（issue #129 语义）。
- [x] **CLI**（`cmd/node-proxy-client`）——flags + env 配置，信号优雅退出，已验证
      windows/amd64、linux/amd64、linux/arm64、darwin/arm64 四平台交叉编译（单文件 ~6.1MB）
- [x] **HTTP request 流处理**（`request.go`）——TS `executeMuxRequest` 全语义对齐：
      从 DATA 帧收集请求体至 END_STREAM、`{type:'response',id,statusCode,statusMessage,headers}` 应答
      （响应头小写化对齐 Node 形状、原样回显请求 id）、503 busy/400 非法 URL/502 上游失败/504 超时、
      重复请求 id 拒绝（issue #123）、并发计数入 stats；net_test 以显式错误应答（不挂服务端超时）
- [x] config.yaml 支持（`gopkg.in/yaml.v3`）——搜索顺序 CONFIG_PATH → cwd/config.{yaml,yml} → exe 旁；
      优先级 env > yaml > 默认；**固定内置常量出现在 yaml 中会被显式告警忽略**（issue #53 语义）
- [~] **Go 服务端数据平面 MVP**（`internal/server` + `cmd/node-proxy-server`，strangler 第一步）：
      - config（YAML + NP_ env，**显式 env 映射修复了 TS 版多词键无法用环境变量覆盖的缺陷**；默认 token 拒启同款守卫）
      - 客户端接入 `/ws`：JSON 控制面（auth/info/heartbeat/stats/limits/legacy response+tunnel_*）
        + mux 分发（tunnel_ready/data/close/error、response、孤儿流 reset——对齐 TS dispatchClientStream 语义）
      - 客户端管理：注册/替换（ownedRegistration 守卫）、随机+tag 路由、简易熔断（连续 5 错开 30s）、
        pending 表 + 节点级超时（35s 隧道/30s 请求）、心跳健康剔除
      - 代理端口：HTTP（absolute-URI + CONNECT 隧道 + Proxy-Auth + 64MiB body 上限）、
        SOCKS5（greeting/user-pass/CONNECT，UDP 待做）
      - 面板最小 API：`POST /api/login`（JWT HS256）+ `GET /api/status`
      - **镜像验收通过**：Go 服务端 + 真实 TS 客户端——plain HTTP / CONNECT / SOCKS5 全通，
        1MB/8MB 经 SOCKS5 MD5 一致；过程中修复 SOCKS5 socket 移交后误关闭的 bug
      - 顺带确认：TS 客户端的 >64KB 截断 bug 在"Go 服务端 + TS 客户端"组合下原样复现
        （服务端忠实转发其所收到之物），建议向上游 TS 项目报告
      - **面板 API 对齐**（第二轮）：web-server.ts 的 57 条路由全部有归宿——status/logs/config/settings
        (GET/POST/reset)、routing/strategy、broadcast、client 的 kick/tags/group/weight/alias/notes/region/
        circuit-breaker reset、circuit-breaker/status、bandwidth/stats、traffic、mux/stats、users（读）、
        proxy-passwords（读）；未移植模块以**显式 501 + 说明**应答而非假装成功；插件系统按既定决策返回空集
      - **运行设置热重载**（settings.go）：白名单五组（routing/circuit_breaker/bandwidth/client/cache），
        面板改后即生效并持久化到 `runtime-overrides.json`（重启重放，可 reset 回启动值）——TS settings.ts
        白名单模式 + issue #122/#122 类缺陷防御（空 body/非法值拒绝）
      - **路由策略四件套**：random / least-loaded（节点自报负载）/ fastest-response（RTT）/ weighted，
        breaker 过滤 + tag 过滤叠加，热切换
      - **热重载活体验收**：在线 TS 客户端实测——改 max_concurrent 后 `limits` 消息实时推送
        （TS 客户端日志确认生效）、策略热切换、面板元数据（tags）读写
      - **UDP 中继**（第三轮）：SOCKS5 UDP ASSOCIATE 完整实现（TCP 控制连接持有关联、
        中继对端 IP 校验——issue #126 语义、FRAG!=0 丢弃、JSON 控制面 udp_data/udp_data_response、
        3 分钟空闲回收）；Go 客户端同步实现；**活体验证：真实 TS 客户端作为中继节点回环成功**；
        响应包装修正了 TS 的双前缀怪癖（TS 在 10 字节 RFC 头前又拼 [00 00 00]，真实 SOCKS5 UDP
        客户端需要多跳 3 字节——只服务端发此包装，修正不影响任何 TS 对端）
      - **Prometheus 指标**：`/metrics` 公开端点（对齐 TS 挂载位置，Grafana 兼容），手写 text
        exposition 零依赖；**指标名/标签与 TS metrics.ts 逐一对应**（requests/bytes/tunnels/errors
        counters、active_clients/requests/tunnels/client_load/bandwidth/circuit_breaker_state gauges、
        request/tunnel duration histograms（同桶）、response_size summary），单 admin 简化角色
      - **安全与路由增强**（第四轮，api_rules.go/acl.go/routing.go）：
        - **ACL**：优先级排序、首个命中生效；条件（源 CIDR/目标域名正则/目标 CIDR/端口范围/
          协议/客户端标签/时间段）全 AND；CRUD API + hits 统计 + 持久化；接入 HTTP/CONNECT/
          SOCKS5/UDP 四条代理路径（活体验证：deny 规则 → curl 403，删除后恢复）
        - **per-password 代理路由**：多代理凭据 CRUD（含 bcrypt 哈希兼容 TS bcryptjs、regenerate），
          凭据→tag/节点/策略路由；与域名路由的优先级对齐 issue #53（密码显式属性 > 域名规则）
        - **域名路由**：`*` 通配模式 → tag，优先级排序，接入 HTTP/CONNECT/SOCKS5/UDP
        - **多用户角色**：admin/operator/viewer 权限表（TS ROLES 对齐），面板用户 CRUD
          （bcrypt 存储、末位 admin 保护、改角色即时生效），全部 API 路由按权限门控
          （client 动作细粒度到 kick/tag/weight...），设置组按 TS SETTINGS_PERM 分别要求
          routing:strategy / system:config
      - **缓存 + 带宽 + 审计**（第五轮，cache.go/bandwidth.go/audit.go）：
        - **响应缓存**：GET-only、凭据请求（Cookie/Authorization）绝不缓存、键含 sorted query +
          Accept 协商、**读时查 TTL**（issue #122）、LRU 驱逐、`x-cache: HIT` 头、settings 'cache'
          组热调 TTL；`/api/cache/stats` + `/api/cache/clear` 转正
        - **带宽令牌桶**：全局桶 + per-client 桶（`client/:id/bandwidth` 覆写）、时钟回拨钳制
          （#122）、settings 'bandwidth' 组热生效、超限 429 + Retry-After
        - **审计日志**：内存环（5000 条）记录代理请求（含早期拒绝：ACL/429/无节点），
          `/api/audit/query?status&clientId&limit` + `/api/audit/stats` 转正；与 TS 的差异：
          TS 落盘文件+轮转，Go 版内存环（存储模块落地时补持久化）
      - **活体验收**：冷启动首请求 200、二次请求 `X-Cache: HIT`、stats/clear/audit 全链路真实代理验证
      - **过程中抓到并修复一个真 bug**：mux 响应的 statusCode 以 int 存入 map[string]any，
        HTTP handler 按 float64 断言失败 → **所有经 mux 的 HTTP 响应状态码默认 502**（body 正确），
        活体验证冷启动暴露
      - **网络测试全链路**（第六轮，nettest.go 双端）：
        - Go 客户端执行器：tcping / http（状态+耗时+吞吐）/ dns（A/AAAA）/ ping（TCP 探测回退，
          mode=tcp——ICMP 原始套接字在 Windows 需特权，记为偏差）；traceroute 显式不支持；
          busy 守卫（单任务）对齐 TS
        - 服务端任务管理：校验（未知类型/空目标/超量 400）、server|all|[ids] 三种调度模式、
          expect 计数、进度/完成汇聚、`POST /api/network-test` + `GET /api/network-test/:id` 转正
        - **进度报文双格式兼容**：TS 客户端把报告字段扁平铺在消息里，Go 客户端嵌套在 result——网关两者都收
        - **活体验收：Go 服务端调度真实 TS 客户端完成 tcping**（结果跨实现回传）
      - **审计持久化**：JSONL 追加写（runtime-audit.jsonl）+ 启动重放尾部，查询跨重启
      - **update/check 转正**：实时查询 GitHub releases/latest（走 HTTPS_PROXY），返回 latest/url
      - **ACME 证书**（第七轮）：`acme:` 配置段（enabled/email/staging/domains）+ `NP_ACME_*`
        环境变量；autocert 管理 Let's Encrypt 证书（staging 目录可切），HTTP-01 挑战挂 :80，
        面板自动切 HTTPS
      - **自动更新应用**：`POST /api/update/apply`（proxy:config 权限）——查最新 release →
        版本串注入防护（TS issue #120 同款）→ 下载平台资产（node-proxy-server-<os>-<arch>）→
        尺寸校验 → 原子换名替换（Windows rename dance，失败回滚）→ 退出交由 supervisor 重启
      - 已知偏差：ping 无 ICMP 模式（TCP 回退）、traceroute 不支持、审计单文件无轮转、
        更新应用需要 release 内含 Go 平台资产（当前 TS 仓库 release 无二进制资产，打资产后生效）
- [x] **Web 面板**（panel/，沿用 nodejs 分支的 Vue3 + naive-ui 代码原样对接 Go 后端）：
      `go:embed` 打进服务端单二进制（登录页 /login、SPA /app、/web-ws 实时推送 status+log）。
      **浏览器实测通过**：登录 → 工作台（节点数/端口/策略/熔断/流量图）→ 节点管理（17 列表格实时状态）
      → 设置五组（保存提示"已保存并即时生效"）。过程中对齐的接口差异：登录响应形状（success/token/redirect）、
      **/api/v1/* 前缀别名**（TS 把同一路由器挂两处，面板走 v1）、/api/kick/:id 快捷路由、
      group 元数据字段、**/api/traffic?days= 每日流量序列**（Manager 30s 采样器）
      重新构建：`cd panel && npm ci && npm run build`（dist 已入库，开箱即用）

## E2E 冒烟与性能对照（已完成，2026-11-07）

真实 TS 服务端（Node 24）+ Go 客户端全链路验证：HTTP 代理（含 1MB/8MB 大响应 MD5 一致）、
SOCKS5 echo 双向、面板注册/心跳/统计全部通过。过程中**发现并修复两个真实 bug**：

1. **>64KB 响应截断**（TS 客户端同款 bug）：`sendData(body, true)` 后立即 `close()`，
   TS 的 close() 对 OPEN 流立即补发 END_STREAM，缓冲未排空的大响应体被截断在发送窗口处。
   Go 版修复为"缓冲排空、真 END_STREAM 发出后再关闭"（`closeAfterDrain`），并附回归测试。
2. **O(n²) 缓冲排放**：TS `Buffer.slice` 是 O(1) 视图，Go 移植初版对剩余数据逐块全量拷贝
   （48MB 体 = ~72GB memcpy，吞吐 3.7MB/s）。改为视图后恢复至 ~2.1Gbps 峰值。

性能对照（详见 [bench/README.md](bench/README.md)）：延迟 p50 0.8ms（持平）、单流吞吐与 TS
同分布（峰值 2.15 vs 2.00 Gbps）、**空载 RSS ~10MB vs ~69MB（7 倍优势）**、单文件 6.1MB。

## 跑 Go 客户端

```bash
go build ./cmd/node-proxy-client
SERVER_URL=ws://your-server:3000/ws AUTH_TOKEN=your-token ./node-proxy-client -quiet
```

互操作测试：

```bash
go test ./internal/interop/ -v   # 需要 Node >= 23.6 与一份 node-proxy 克隆（NODE_PROXY_TS_REPO）
```

## 会话层与 TS 的有意差异

会话层逐行为镜像 TS（流控窗口加减、批量发送、状态机、连接帧处理），但有三处刻意不同，均已注释在代码中：

1. **延迟 END_STREAM 修复**：TS 在 `sendData(endStream=true)` 数据被缓冲时，缓冲排空后**永远不发**
   END_STREAM（对端永远无法半关闭）；Go 版在缓冲排空时补发（`pendingEnd`）。TS 对端将该帧按普通
   END_STREAM 正常处理，属线格式正确化修复，非破坏兼容。
2. **背压模型**：TS 轮询 `ws.bufferedAmount` + 延迟重试（100 次上限）；Go 用独立 writer goroutine
   阻塞写 Transport，天然背压，无需该补丁。
3. **回调时序**：TS 单线程事件循环里回调天然同步；Go 的 `dispatch` 逐帧"加锁处理→解锁→触发回调"，
   复刻了"同一消息内 TUNNEL_OPEN 的 OnStream 先于后续 DATA 帧触发"的事件循环语义（否则同批 DATA
   会在消费者挂载 handler 前被丢弃——移植过程中实测踩过这个坑）。

另：TS 的优先级队列实际只排序、不参与发送（发送是 FIFO 批量），Go 端如实保留为纯元数据。

## StreamMux 协议（与 TS 实现保持一致）

```
frame  = [4B payload length BE][1B type][4B stream id BE][4B flags BE][payload]
ws msg = frame | batch
batch  = [2B frame count BE] frame{count}    (count >= 2)
```

- 13 种帧类型（0x01 HEADERS … 0x0D TUNNEL_CLOSE）；批处理判别用消息前 2 字节
  （uint16 BE）≥ 2，因单帧 payload 上限 16 KiB（长度字段高 16 位恒为 0），无歧义。
- payload：DATA / TUNNEL_DATA 为原始字节，其余为紧凑 JSON。
- 限制：`MaxFrameSize=16384`、批总量 ≤64 KiB、并发流 ≤512、流窗口 64 KiB、
  连接窗口 1 MiB、WINDOW_UPDATE 增量上限 16 MiB、流 ID 从 1 起步进 2（奇数）。
- 收侧对畸形/截断帧一律丢弃并保持连接，解析批数据遇坏帧即停（保留已解出的帧）。

## 字节级兼容性测试

golden vectors 由**真实 TS 编码器**生成（当前对应 node-proxy@3d9a89a），
Go 测试断言：解码一致 + 重新编码逐字节一致。

```bash
# 跑测试（含 golden 一致性）
go test ./...

# TS 仓库有更新后重新生成 golden（需 Node >= 23.6 与一份 node-proxy 克隆）
node tools/gen-goldens/gen-goldens.mjs <node-proxy克隆目录> internal/streammux/testdata/golden.json
```

## CI / 发布

- **CI**（`ci.yml`）：push/PR 到 main 时跑 gofmt 检查、`go vet`、全量 `-race` 测试、五平台交叉编译检查。
  互操作测试在 CI 上自动跳过（无 TS 仓库时 skip 的设计在此兑现）。
- **发布**（`release.yml`）：打 `v*` tag 自动构建五平台（windows/linux/darwin × amd64/arm64）双端二进制
  并创建 GitHub Release，资产命名与 `update/apply` 的 `assetNameFor` 精确匹配（含 sha256sum），
  版本号经 ldflags 注入——**打完 tag 自更新链路即刻可用**。

## 目录

```
internal/streammux/   StreamMux wire codec + 单元/一致性测试
tools/gen-goldens/    用 TS 编码器生成 golden vectors 的脚本
```
