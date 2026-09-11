# ChatGPT Web Harness Isolated 0.2.0

## 直接使用

安装版：ChatGPT Web Harness Isolated-0.2.0-setup.exe。便携版：ChatGPT Web Harness Isolated-0.2.0-portable.exe。选择其中一种使用即可，无须安装 Node.js 或保留源码目录。便携版默认仍将配置保存到当前 Windows 用户的独立产品数据目录，不是把凭据明文放在 EXE 旁边。

先阅读 USER_GUIDE.zh-CN.md，再在“设置”填写自己的账号配置。点击“+ 新账号”建立 B 的独立配置；新账号不会复制 A 的密钥。切换账号不会停止前一个账号的服务。

## 本次实际验证

完整根工程回归、当前桌面回归通过；实际安装版和便携版的 9 项包体验收通过。覆盖首次启动、真实新建/重命名/切换、配置冲突拒绝、双 MCP 并发及选择性停止、独立 Skills/嵌套文件、重启持久化、900px 窗口，以及真实安装、运行和静默卸载。8 个实际界面视图完成视觉检查。源码和打包运行文件已比对，清理过程未修改原有安装和正在使用的连接。

Electron 41.10.3 / 内置 Node.js 24.18.0。桌面锁定依赖的本次 npm audit 报告为 0 已知漏洞；这不是不存在未知漏洞的保证。详细验证摘要见 VALIDATION.json，校验值见 SHA256SUMS.txt。

## 必须说明的边界

程序和安装器没有 Authenticode 签名。两份真实 ChatGPT 云端账号的隧道连接尚未实测，需要使用各自合法账号凭据验证，不能把本地 MCP 在线等同于云端已连接。多账号是同一 Windows 用户下的配置和进程隔离，不是操作系统级安全沙箱。发行包不预装用户 Skills。

本版与旧产品分开安装和存储，不会自动迁移旧产品密钥；静默卸载保留用户配置。原始测试截图含本机路径，因此未放进公开包。此项目不是 OpenAI 官方桌面软件。

## 发布到 GitHub

将配套 source.zip 解压后的源码根目录审查后提交到自己的仓库；EXE 与 release.zip 作为 Release 附件，不要混入源码历史。保留 LICENSE 和 third-party 通知，参见 RELEASE.md。本轮仅准备和验证本地发布包，没有推送或创建远程 Release。
