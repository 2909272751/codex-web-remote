# Codex Web Remote

在手机、平板或另一台电脑的浏览器中访问当前 Windows 电脑上的 Codex 任务。项目使用官方 Codex `app-server`/CLI 作为对话后端，并提供适配桌面、iPad 和手机的 Web 界面。

> 这是社区项目，不是 OpenAI 官方产品。请勿把服务直接暴露到不可信网络。

## 主要功能

- 读取本机 Codex 历史任务并继续对话
- 模型和推理强度切换、完全访问权限、审批与用户输入
- 思考状态、计划、命令输出、文件变更、Diff 和工具进度
- 引导消息、排队消息以及任务完成后自动继续队列
- 上传文件、粘贴和预览图片
- 使用量与额度重置时间显示
- 独立 Edge/Playwright 浏览器工具：打开、读取、点击、填写与截图
- 24 小时免重复登录、隐藏启动和 Windows 登录后自启动
- 响应式布局，支持高分辨率电脑、iPad 和手机

## 新电脑安装（推荐）

### 1. 准备环境

1. 使用 Windows 10/11 x64。
2. 安装并登录 Codex Windows App，确认至少能正常打开一个任务。
3. 确保 Microsoft Edge 已安装。
4. 从 GitHub Releases 下载 `codex-web-remote-v1.0.0-windows-x64.zip`，不要下载自动生成的 Source code 压缩包。

Release 包已包含 Node.js、Codex CLI、Playwright MCP 和项目依赖，新电脑不需要安装 Node、npm 或 pnpm。

### 2. 安装

1. 将压缩包完整解压到固定目录，例如 `C:\Tools\codex-web-remote-v1.0.0-windows-x64`。
2. 打开 PowerShell，进入解压后的目录。
3. 运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

4. 根据提示设置至少 8 位的 Web 密码。
5. 安装脚本会创建 `Codex Web Remote` 登录自启动任务并启动服务。
6. 在本机访问 [http://127.0.0.1:18888](http://127.0.0.1:18888)。

密码只保存在本机 `.env.local`，该文件不会上传到 GitHub，也不会包含在 Release 包中。

### 3. 配置 88frp

在 88frp 新建 HTTP 或 HTTPS 隧道：

```text
本地地址：127.0.0.1
本地端口：18888
```

之后通过 88frp 分配的公网地址访问。文件和图片上传也使用同一个端口。

强烈建议使用 HTTPS。若公网入口已经是 HTTPS，可将 `.env.local` 中的设置改为：

```text
CODEX_WEB_SECURE_COOKIE=1
```

保存后在任务计划程序中重启 `Codex Web Remote`。

## 日常使用

- 桌面 App 正在执行任务时，Web 会提示稍后重试。
- Web 取得控制权后，可以继续现有任务或创建新任务。
- 不要在桌面 App 和 Web 可写模式中同时发送消息。
- Web 浏览器工具使用独立 Edge 配置，不共享桌面 Codex App 中 Browser 的标签页和登录状态。
- 上传内容保存在 `%USERPROFILE%\.codex\web-uploads`，默认保留七天。

## 手动启动和卸载自启动

前台启动，适合排错：

```powershell
.\start.ps1
```

重新安装自启动：

```powershell
.\install-autostart.ps1
```

移除自启动任务：

```powershell
.\uninstall-autostart.ps1
```

移除自启动不会删除项目、密码、Codex 任务或上传文件。

## 从源码运行

源码开发需要 Node.js 22+ 和 pnpm：

```powershell
pnpm install --frozen-lockfile
.\start.ps1
```

运行检查：

```powershell
pnpm run check
pnpm run test:requests
pnpm run test:reasoning
pnpm run test:browser-mcp
pnpm run smoke
```

构建便携发布包：

```powershell
.\build-release.ps1 -Version 1.0.0
```

## 安全说明

- 服务带密码验证、失败限速、HttpOnly/SameSite Cookie，但它不是面向公共互联网设计的多用户系统。
- 推荐把监听地址保持为 `127.0.0.1`，通过受控的 HTTPS 隧道访问。
- 不要提交 `.env.local`、`.runtime-data`、Codex 登录文件或浏览器资料。
- 默认拒绝上传 EXE、DLL、MSI、BAT、CMD、COM、SCR 和 PS1。

## 已知限制

Windows 当前无法启动官方 `codex remote-control` app-server daemon，因此本项目使用独立 Playwright/Edge 后端提供浏览能力。它不是桌面 Codex App 中同一个 Browser 标签页。

Codex `app-server` 协议可能随版本变化。升级 `@openai/codex` 后应重新运行全部测试。

## License

[MIT](LICENSE)
