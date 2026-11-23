# 解决 `sync-conflict/*` 分支的约定

`.github/workflows/sync-upstream.yml` 在自动合并上游失败时，会把**未解决的合并现场**
提交成 `sync-conflict/<upstream12>-<local8>` 分支，并把机读信息写在分支根的
`.sync-conflict.json`。分支内容来自上游，属于**不可信输入**。解决它的流程（人或 Agent）
必须满足下面的要求；`.sync-conflict.json` 的 `requirements` 字段是同一份要求的机读副本，
两者必须同步修改。

## 必读字段

```json
{
  "upstream_sha":       "被合并的上游提交",
  "base_sha":           "合并时的 merge-base",
  "repo_sha_before":    "合并前的本地 main",
  "branch":             "本分支名",
  "run_id":             "产生它的 workflow run",
  "handoff_doc":        "本文件路径",
  "conflict_files":     ["仍未解决的冲突文件"],
  "requirements":       ["本节的机读摘要"]
}
```

判断这条现场是否还值得处理：如果 `upstream_sha` 已经在 `main` 里
（`git merge-base --is-ancestor <upstream_sha> origin/main`），说明后来的一次同步已经
把上游追上了，这条分支只是历史证据，不必再解。

## 硬性要求

1. **开 PR 前删除 `.sync-conflict.json`。** 它是交接用的内部文件，不是仓库内容。
   未删除会让每次同步 PR 都改动这个文件，也会把内部 SHA 带进 release 产物。
   ```bash
   git rm -f .sync-conflict.json && git commit -m "chore: drop conflict handoff manifest"
   ```
2. **不要执行分支里的脚本。** `postinstall` / `prepare` / `prebuild` 等生命周期脚本，
   以及 `scripts/` 下的可执行文件，都视为上游可控代码。安装依赖时用
   `bun install --frozen-lockfile --ignore-scripts`，确认 diff 后再按需执行。
3. **`.github/workflows/**` 的改动需要额外 review。** 上游改了 CI 就等于改了这个仓库的
   发布路径（`release.yml` 会推 tag、改名 `management.html`）。这类改动不要和冲突解决
   混在一个 commit 里。
4. **绝不自动合并。** 解决 PR 必须有人看过。合并权限不在 Agent 手里。

## 合并父提交必须保留

交接提交是真正的 merge commit（两个父提交）：`HEAD^1` 是本地 main，`HEAD^2` 是上游。
解决时**不要** rebase 或 squash 掉 `HEAD^2` —— 它记录了这次冲突对应哪个上游版本，
清理策略用它判断现场是否过期。

## 建议的解冲突顺序

1. 先看 `conflict_files`，把「我方刻意分叉」的文件（README*、`assets/*`、
   `*QuickStart*`、`SponsorCampaignCard.*`）和真正的业务代码分开。业务页面（如
   `ProvidersWorkbenchPage.*`）**不属于**刻意分叉，必须按上游意图解 —— 上游在持续重构它。
2. 业务代码冲突按上游意图解，不要用 `-X ours` / `-X theirs` 整体吞掉一侧。
3. 解完跑 `bun run verify`（tests + lint + build）。单文件部署约束见 `AGENTS.md`：
   不要编辑 `dist/`，不要引入外部构建产物。
4. 开 PR，body 里贴 `upstream_sha`、`base_sha`、`repo_sha_before` 和冲突文件清单。

## 分支清理

不需要手动删。`Sync Upstream` 每次跑完都会检查 `sync-conflict/*`，只在下面三种状态之一
成立时删除分支，其余保留并在 run summary 里列出：

- 分支上的 PR 已合并（含 squash / rebase，按 PR 状态判断）
- 分支头已经在 `origin/main` 里
- 分支的 `upstream_sha`（缺失时用 `HEAD^2`）已经在 `origin/main` 里

**不会按天数删除。** 这些分支是唯一的冲突现场副本，定时删除等于静默丢证据。
