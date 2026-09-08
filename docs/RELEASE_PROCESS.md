# GitHub 仓库维护与自动发布说明

产品名称：**ChatGPT Web Harness**
目标仓库：https://github.com/jamesmendax/chatgpt-local-coder-enhanced
本地公开发布副本：`D:\chatgpt-local-coder-public`
生产 MCP：`D:\chatgpt-local-coder`

`chatgpt-local-coder-enhanced` 是保留既有链接与 Release 历史的仓库路径，公开产品名称已经改为 **ChatGPT Web Harness**。不要为名称变更另建仓库，也不要向相似名称的 `jamesmendax/chatgpt-local-coder` 发布。

生产 MCP 和公开 GitHub 仓库不是同一个工作目录。新功能首先在生产 MCP 中验证，确认稳定之后，再把适合公开的代码移植到 chatgpt-local-coder-public。绝对不能直接把生产目录整个复制进公开仓库，因为生产目录可能包含 `.env`、Tunnel ID、本地配置、密钥、本机状态等私人信息。

## 标准发布流程

1. 确认 GitHub 真实远端：`cd D:\chatgpt-local-coder-public && git remote -v && git fetch origin --prune && npm run check:release-target`
2. 当前正确仓库应该是：`origin https://github.com/jamesmendax/chatgpt-local-coder-enhanced.git`
3. 如果不是：`git remote set-url origin https://github.com/jamesmendax/chatgpt-local-coder-enhanced.git`
4. 不要因为本地仓库旧，就直接 force push。先检查：`git status`、`git rev-list --left-right --count HEAD...origin/main`、`git log --oneline -10`
5. 如果本地和 GitHub 已经分叉，要先备份：`git branch backup/pre-sync-YYYYMMDD && git stash push -m "pre-sync"`,然后再安全对齐 origin/main。
6. 只移植已经在生产环境验证过的功能。
7. 不应同步:`.env`、`.secrets/`、Runtime API Key、Tunnel ID、DPAPI 文件、`profiles/*.yaml` 中的真实配置、audit log、本机 workspace 数据、`dist/`、`node_modules/`。
8. 修改版本号(例如 `1.2.0 -> 1.3.0`):package.json 与 package-lock.json 的根 version 要保持一致。不要使用粗暴的全文件版本号替换,因为 package-lock.json 中可能存在第三方依赖恰好也是旧版本号——用 `npm install --package-lock-only` 同步。
9. 更新 CHANGELOG.md。
10. 创建对应 Release Notes 文件:`.github/releases/vX.Y.Z.md`。这个文件会被 GitHub Actions 自动拿来生成 GitHub Release 的说明。
11. 正式发布之前必须跑完整验证：`npm run verify:release`。它先执行 `npm run verify`（`npm run check:secrets` + `npm run test:all`），再验证 `origin`、`package.json` 和 GitHub Actions 环境都指向唯一正确仓库。必须看到 `No obvious public secret patterns found.`、`=== ALL TESTS PASSED ===` 和 `Release target verified: jamesmendax/chatgpt-local-coder-enhanced`。任何一项失败都禁止发布。
12. 发布前检查 Git diff:`git status`、`git diff --check`、`git diff --stat`、`git diff --name-only`。仔细确认没有 `.env`、API Key、Tunnel ID、用户文件、临时文件、生产机专属数据。
13. 创建 Release Commit:GitHub Release Workflow 使用 `if: startsWith(github.event.head_commit.message, 'release:')`,所以正式发布提交必须形如 `git commit -m "release: v1.3.0"`。普通的 `feat:`/`fix:`/`docs:` 提交不会触发 Release。
14. 推送 GitHub：`git push origin main`。如果权限或远端校验失败，停止并修复 `origin`/账号权限；禁止通过新建另一个仓库绕过失败。到这里本机工作结束。

预览版也必须留在同一个规范仓库中，可使用独立的 `release/*` 分支、预发布标签和 Release。不得把预览版及其历史标签发布到另一个仓库。稳定版仍只按下面的 `main` + `release:` 自动发布流程执行。

## 发布架构

```
AI 修改公开仓库
      ↓
npm run verify:release
      ↓
git commit -m "release: vX.Y.Z"
      ↓
git push origin main
      ↓
GitHub 收到 push → CI Workflow 自动运行 → Release Workflow 自动运行
      ↓
GitHub 云端 Runner 使用 gh CLI(凭据由 GitHub Actions 自动注入的仓库令牌提供)
      ↓
创建 tag vX.Y.Z → 创建 GitHub Release(notes 来自 .github/releases/vX.Y.Z.md)
```

本机不需要安装 gh、不需要保存 GitHub Personal Access Token、不需要执行 gh release create。AI 负责代码、测试、Git commit/push;GitHub Actions 负责 GitHub Release——比让 AI 在本机长期持有仓库写权限的 gh 登录状态更干净、更容易重复和审计。
