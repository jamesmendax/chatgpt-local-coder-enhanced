# 发布与复现

## 文件分工

github-source 是可提交到仓库的源码根目录；source.zip 是它的归档。安装版和 Portable 放在 GitHub Release 附件，不要把生成的 EXE 提交到源代码历史。release.zip 用于完整分发程序、中文指南、验证摘要和许可证。

目录中的原始仓库地址和作者元数据用于上游归属，不能视为当前 fork 已发布的位置。导入自己的仓库后可独立调整 fork 的 repository/homepage 字段，但必须保留 LICENSE 的原版权声明。

## 构建

Windows x64 + Node.js 24/npm，执行 BUILD.ps1。两份锁文件和 bin/tunnel-client.exe 必须保留。第三方二进制的原始下载 URL、ZIP 哈希与 exe 哈希见 third-party/tunnel-client/PROVENANCE.json。许可证见同目录 LICENSE/NOTICE。

构建过程使用锁定依赖，但安装器时间戳等因素可能改变重建文件的字节哈希；没有声称跨环境的逐字节可重现构建。随包 SHA256SUMS.txt 校验的是本次实际交付文件。

## 验证与发布顺序

依次执行隔离的 root/desktop 回归、构建，再在无本产品安装和数据的干净 Windows 用户下运行 acceptance-multiaccount.mjs。查看完整 assertions 和退出码，不能只看 EXE 存在。该脚本会真实安装和卸载候选，因此不要用于生产账号已有数据环境。

本次没有自动 push、创建 tag 或发布 Release。人工发布时先审查源码及许可证，再提交源码；将两个 EXE、release.zip、SHA256SUMS.txt、VALIDATION.json 和中文指南作为 Release 附件。

发行构建未签名。公开长期发布前应考虑适当代码签名、依赖复审与真实账户云端验收；不要在说明中写成这些步骤已经完成。

## 排除项

不公开 .git、node_modules、staging、内部交接与个人配置、.codex、审计/命令日志、原始测试截图中的本机目录，以及真实密钥。源代码中的路径占位符和独立测试用虚构凭据不是个人凭据。
