# AGENTS.md — 开发守则

> 适用于所有开发者与 AI 编码代理。默认分支 `main`，远程 `origin`（GitHub）。

## 核心规范

1. **所有更改必须通过 GitHub PR 合入 `main`**。
   禁止本地合并分支后 push、禁止直接 `git push origin main`、禁止任何绕过 PR 的合入。
2. **合入只能由 `gh pr merge` 执行，且必须使用压缩合并（squash）**。
   禁止本地 `git merge`/`git rebase` 合入 PR 分支；禁止在 GitHub Web 使用普通/Rebase merge。
3. **更改拆分为最小功能的 commit**；相关功能的 commit 汇总为一个 PR，squash 成一条提交落到 `main`。
   **PR 标题 = 压缩后的提交信息**，符合 Conventional Commits。

## 标准流程

```text
同步 main → 建分支 → 最小 commit 逐步提交 → push 分支 → gh pr create → gh pr merge --squash
```

```bash
git checkout main && git pull origin main
git checkout -b <type>/<short-description>

# 每次只提交一个最小功能点
git commit -m "<type>: <简短描述>"
git push -u origin <branch>

# PR 标题 = 压缩后的提交信息
gh pr create --base main --head <branch> --title "<type>: <简短描述>" --body "<变更说明>"

# 唯一合法的合入方式
gh pr merge <branch> --squash --delete-branch

# 合入后同步
git checkout main && git pull origin main && git branch -D <branch>
```

CI 失败或 review 需修改时：在**同一分支**补最小 commit 并 push，不要另开分支。

## 提交规范（Conventional Commits）

格式：`<type>(<scope>)?: <简短描述>`

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改行为） |
| `docs` | 文档 |
| `chore` | 构建/依赖/配置/杂务 |
| `test` | 测试 |
| `perf` | 性能优化 |
| `style` | 格式（不改行为） |

示例：`feat: client metadata management - alias, notes, region override`、`fix: make alias/notes/region cells actually clickable to edit`、`docs: readme default credentials`。

- 一个 commit 只做一件事；描述用祈使句、小写开头，≤72 字符。
- 禁止 `update files` / `wip` 等无意义提交。

### 提交签名（尽量）

- 尽量对提交启用签名：**优先 GPG 签名**（`git config commit.gpgsign true`），其次 **SSH 私钥签名**（`git config gpg.format ssh` + 配置 `user.signingkey`）。
- 签名为“尽量”项，**不签名也允许提交**；不要因签名失败而阻塞提交流程。

## 分支命名

```text
<type>/<short-description>
```

例：`feat/client-metadata`、`fix/clickable-client-cells`、`docs/readme-default-credentials`、`chore/move-server-deploy-files`。一个 PR 对应一个分支，合入后删除。

## 仓库目录规范

```
node-proxy/
├── server/                 # 服务端（Node.js）
│   ├── server.js          # 入口文件
│   ├── config.yaml        # 默认配置
│   ├── lib/               # 核心模块
│   ├── public/            # 前端静态资源
│   ├── views/             # HTML 模板
│   ├── plugins/           # 插件目录
│   ├── Dockerfile         # 服务端镜像构建
│   ├── docker-compose.yml # 服务端编排
│   └── prometheus.yml     # 监控配置
├── client/                 # 客户端（client.js、lib/、Dockerfile、docker-compose.client.yml）
├── deploy/                 # 部署脚本：systemd 服务、WinSW 配置
└── .github/workflows/      # CI/CD 工作流
```

目录规则：

- 客户端相关代码只放 `client/`，不放进 `server/`。
- 部署/安装相关文件放 `deploy/`；CI 工作流放 `.github/workflows/`。
- 服务端镜像构建与编排文件（`Dockerfile`、`docker-compose.yml`、`prometheus.yml`）**归属 `server/`**；改镜像相关配置时同步更新 `server/` 下对应文件及 `.github/workflows/`。
- 现状：根目录仍有这三个文件，属历史遗留（暂不迁移）；正式迁移需单独开 PR 完成，迁移后根目录不再保留。

## 禁止事项

- ❌ 本地合并分支或直推 `main`；❌ 用 `gh pr merge` 之外的方式合入 PR。
- ❌ 一个 commit / 一个 PR 混入多项无关更改。
- ❌ 提交密钥、日志、`node_modules` 等（见 `.gitignore`）。
- ❌ 文档类更改也**必须**走 PR 流程，不允许直接提交 `main`。

## 适用对象

- 本守则适用于所有人工与代理提交；冲突时以本文件为准。
- 本文件自身的更改同样必须通过 PR 流程合入。