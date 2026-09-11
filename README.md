# ChatGPT Web Harness Isolated 0.2.0

Windows 桌面端，多账号配置与独立 MCP / Tunnel 生命周期管理。此项目基于 chatgpt-local-coder 的现有代码发展，保留原始 MIT 版权声明；不是 OpenAI 官方桌面产品。

## 普通使用者

使用配套 Release 中的安装版 setup.exe 或免安装 Portable EXE，无须先安装 Node.js，也不需要把本源码目录放在固定盘符。首次启动进入“设置”完成当前账号配置。详细说明见 [中文使用指南](docs/USER_GUIDE.zh-CN.md)。

每个桌面账号是本机配置档，不是代替你登录 ChatGPT 的账号登录器。它分别管理账号名称、工作区、三个本地端口、Tunnel ID、加密保存的 Runtime API Key、运行目录、日志和 Skills。新建账号不会复制其他账号密钥；切换当前账号不会停止其他账号服务；停止 B 不影响 A。退出应用会停止本应用管理的所有账号进程。

本版使用独立产品名称和数据目录，不自动导入原版 0.1.3 的凭据，不替换原版安装。已有本产品配置升级后保持为默认账号；不要把“保留独立版原配置”理解为自动迁移另一产品的密钥。

## 源码构建

Windows x64、Node.js 24 与 npm；推荐标准 Node.js 安装方式。根目录和 desktop 均提供 package-lock.json，使用 npm ci，不要改用无锁安装或复制其他项目的 node_modules。

```powershell
npm ci
npm --prefix desktop ci
npm run build
npm --prefix desktop run dist
```

也可执行 ./BUILD.ps1；脚本逐步检查退出码。构建结果位于 desktop/release，包含安装版和 Portable。构建不发布 GitHub Release。发布时使用 [发布说明](docs/RELEASE.md)。

源码包包含桌面 main/preload/renderer、MCP TypeScript 源码、测试与脚本、打包设置、图标、默认空配置、全部锁文件，以及经过上游哈希核验的 Windows tunnel-client。第三方许可证与来源记录在 third-party；Electron 与 npm 依赖在锁定安装时取得。

## 验证

先安装两层开发依赖。隔离验证入口会使用临时工作区、运行状态和空 dotenv，不继承真实运行凭据：

```powershell
node .release-tools/verify.cjs root
node .release-tools/verify.cjs desktop
```

实际 EXE 验收入口：

```powershell
node desktop/scripts/acceptance-multiaccount.mjs
```

该验收会真实运行安装器、Portable 和卸载器，只能在尚无本产品数据、进程与安装记录的干净 Windows 用户下运行。它不会接管或清空已有数据。也可在仓库根目录执行 npm run acceptance，它现已指向新的多账号包体验收。旧脚本仅保留为 desktop 的 acceptance:legacy，不用于本产品交付验收，也不要在生产数据环境运行。

## 发布边界

当前为同 Windows 用户下的配置与进程隔离，不是操作系统沙箱；拥有任意 shell 权限的账号不应被视为互不信任的安全主体。使用多用户/虚拟机才能建立更强边界。

独立本地 MCP 并发、界面和安装路径可以本地验收；两个真实 ChatGPT 账号的云端连接需要各自有效凭据，不能从本地 ready/health 推断云端已连接。

本次构建没有代码签名。不要把 Windows 签名/信誉提示当成已通过的发布项，不建议关闭系统安全防护。

公开源码包刻意排除了内部交接、个人状态、日志、真实配置、凭据与历史失败附件；它不是私人工作目录的逐文件镜像。已有历史记录仍保留在原工作目录。
