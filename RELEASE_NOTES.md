# Codex Web Remote v1.0.0

首个公开 Windows 版本。

## 功能

- Codex 历史任务浏览和继续对话
- 模型、推理强度、完全访问权限和审批交互
- 思考过程、计划、命令、文件变更、Diff 与工具状态
- 引导、队列及自动执行下一条任务
- 文件上传与图片粘贴
- 使用量和额度重置显示
- 独立 Microsoft Edge 浏览器工具
- 电脑、iPad 和手机响应式界面
- 密码登录、24 小时会话和隐藏自启动

## 安装

1. 在 Windows 10/11 x64 上安装并登录 Codex Windows App。
2. 下载 `codex-web-remote-v1.0.0-windows-x64.zip`。
3. 完整解压后，在 PowerShell 中运行 `Set-ExecutionPolicy -Scope Process Bypass`。
4. 运行 `.\setup.ps1`，设置 Web 密码。
5. 本机打开 `http://127.0.0.1:18888`；远程访问可将 88frp 指向 `127.0.0.1:18888`。

发布包已包含 Node.js 和运行依赖。SHA256 校验值见同名 `.sha256` 文件。
