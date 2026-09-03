# AGENTS.md — 本仓库开发守则

> 本文件对所有开发者与 AI 编码代理（下称“代理”）具有强制约束力。
> 工作目录：本仓库（`WAADRI/node-proxy`），默认分支：`main`，远程：`origin`（GitHub）。

## 0. 三条铁律（违反即视为严重错误）

1. **每次更改必须通过 GitHub Pull Request（PR）合入 `main`**。
   - 禁止在本地把分支合并进 `main` 后直接 `git push origin main`。
   - 禁止任何绕过 PR 的合入方式（本地 merge、本地 rebase 到 main 再强推、直接用 `git push origin main` 等）。
2. **合入只能由 `gh pr merge` 在 GitHub 上执行**，且 **必须使用压缩合并（squash merge）**。
   - 禁止在本地执行 `git merge` / `git rebase` / `git cherry-pick` 来合入 PR 分支。
   - 禁止在 GitHub Web 界面使用普通 merge 或 rebase merge 按钮。
3. **变更必须拆分为最小功能的 commit；相关功能的所有 commit 汇总为一个 PR，用一个 squash 合并成一个提交落到 `main` 上。**
   - PR 的**标题 = 压缩后的那个提交信息**，必须简明、动词开头、符合 Conventional Commits。

---

## 1. 工作流程（每次更改的标准流程）

一次“更改”（feature / fix / chore / docs）严格按以下步骤执行：

```text
创建分支 → 最小 commit 逐步提交 → push 分支 → gh pr create → 检查/等待 CI → gh pr merge --squash
```

### 步骤 1：同步并创建分支

```bash
git checkout main
git pull origin main
git checkout -b <type>/<short-description>   # 分支命名见第 3 节
```

### 步骤 2：最小功能粒度提交

- 一次提交只做**一件最小的事**（一个功能点 / 一个修复 / 一处重构 / 一份文档）。
- 提交信息使用 Conventional Commits（见第 2 节）。
- 不要在一个 commit 里混入无关改动；发现无关改动先 `git add` 指定文件/区块，不要把 `git add -A` 当默认操作。

### 步骤 3：推送分支

```bash
git push -u origin <branch>
```

> 注意：`push` 只能推**特性分支**，绝不能直接推 `main`。可以在本地多次 `git commit`，但绝不要在本地把分支并入 `main`（铁律 1）。

### 步骤 4：在 GitHub 开 PR（用 `gh`）

```bash
gh pr create \
  --base main \
  --head <branch> \
  --title "<压缩后的提交信息>" \
  --body "<变更说明>"
```

- `--title` 直接使用压缩合并后的最终提交信息（见第 4 节）。
- `--body` 写清楚：变更内容、为什么改、测试方式、有无破坏性变更。
- 关联 issue（如有）：在 body 里写 `Closes #<issue>`。

### 步骤 5：检查 PR

- 确认 PR diff 只包含本次相关更改，无多余文件、无调试残留、无密钥/日志。
- 等待 CI（若有）通过；失败则继续在**同一分支**上补最小 commit 并 push，不要另开分支。

### 步骤 6：用 `gh` 执行压缩合并（唯一合法的合入方式）

```bash
gh pr merge <pr-number|branch> --squash --delete-branch
```

- `--squash`：**必须带**，禁止省略（铁律 2）。
- `--delete-branch`：合入后删除远端分支，推荐保留。
- 合入后立即同步本地：

```bash
git checkout main
git pull origin main
git branch -D <branch>   # 本地旧分支清理
```

---

## 2. 提交信息规范（Conventional Commits）

每个 commit 必须是**一个最小功能**，格式：

```text
<type>(<scope>)?: <简短描述>
```

常用 `<type>`：

| type      | 用途                                   |
|-----------|----------------------------------------|
| `feat`    | 新功能                                 |
| `fix`     | 缺陷修复                               |
| `refactor`| 重构，不改变行为                       |
| `docs`    | 文档（README、注释、AGENTS.md 等）    |
| `chore`   | 构建/依赖/配置/杂务                    |
| `test`    | 测试                                   |
| `perf`    | 性能优化                               |
| `style`   | 格式、空白、lint（不改行为）           |

示例（参考本仓库已有历史）：

```text
feat: client metadata management - alias, notes, region override
fix: make alias/notes/region cells actually clickable to edit
ui: client table scroll + sticky header + pinned actions column
docs: readme default credentials
chore: move server deploy files
```

- 描述用祈使句、小写开头，能看懂即可，不建议超过 72 字符。
- **不要**使用“update files”“fix stuff”“wip”“临时提交”等无意义信息。
- 谨慎使用 `--amend`：只在分支尚未 push 或可安全强推自己分支时使用。

---

## 3. 分支命名规范

```text
<type>/<short-description>
```

示例：`feat/client-metadata`、`fix/clickable-client-cells`、`docs/readme-default-credentials`、`chore/move-server-deploy-files`。

- `<type>` 与第 2 节一致；描述用 `-` 连接小写单词。
- 一个 PR 对应一个分支；分支生命周期 = 该 PR 的生命周期，合入后即删除。

---

## 4. PR 标题与压缩提交

- 一次 PR 只承载**一个功能主题**（一个 PR = 一个 squash 提交）。
- **PR 标题 = 压缩后的提交信息**，即合并进 `main` 历史里的那一条。
- 若 PR 内有多个最小 commit，最终 squash 信息应以**最能概括整体变更的那条 commit** 为准（通常与主 commit 相同），格式仍遵守 Conventional Commits。
- 示例：分支 `feat/client-metadata` 内有 3 个 commit，PR 标题统一为
  `feat: client metadata management - alias, notes, region override`，
  合入后 `main` 历史只出现这一条。

---

## 5. 禁止事项（Do NOT）

- ❌ 本地 `git merge <branch>` 或 `git rebase main` 后 `git push origin main`。
- ❌ 任何写向 `main` 的 `git push`（含 `git push origin main:main`、强推）。
- ❌ 在 GitHub Web 上点普通 Merge / Rebase and merge 按钮。
- ❌ 用 `gh pr merge` 之外的任何方式合入 PR。
- ❌ 一次 commit / 一个 PR 塞入无关的多项更改。
- ❌ 把密钥、日志、临时脚本、`node_modules` 等提交进仓库（见 `.gitignore`）。
- ❌ 直接提交到 `main` 分支（即使只是文档）——文档类更改同样走上面的 PR 流程。

---

## 6. 常用命令速查

```bash
# 新功能分支
git checkout -b feat/my-feature
git push -u origin feat/my-feature

# 开 PR
gh pr create --base main --head feat/my-feature \
  --title "feat: my feature" --body "..." 

# 查看 PR
gh pr view

# 压缩合并（唯一允许的合入方式）
gh pr merge feat/my-feature --squash --delete-branch

# 合入后同步
git checkout main && git pull origin main
```

---

## 7. 适用对象与优先级

- 本守则适用于所有人工提交和代理自动提交。
- 若与仓库其他文档冲突，以本文件为准；本文件自身的更改也必须通过 PR 流程合入本仓库。