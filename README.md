# Codex Web Remote

在手机、iPad 或另一台电脑的浏览器中访问当前 Windows 电脑上的 Codex 任务。项目使用官方 Codex `app-server`/CLI 作为对话后端，并提供图形化安装器、Windows 托盘控制中心和响应式 PWA。

> 这是社区项目，不是 OpenAI 官方产品。请勿把服务直接暴露到不可信网络。

## 主要功能

- 双击 `Setup.exe` 安装，不要求用户安装 Node.js 或使用命令行
- 原生首次设置界面和 Windows 托盘控制中心
- 读取本机 Codex 历史任务并继续对话
- 在接管前管理项目，远程浏览主机磁盘和文件夹，并在指定项目中创建任务
- 模型、推理强度、完全访问权限、审批与用户输入
- 思考状态、计划、命令输出、文件变更、Diff 和工具进度
- 引导、排队以及任务完成后自动执行下一条消息
- 多个已登录 Web 设备共享控制，可同时查看和发送；同一任务的并发消息自动串行排队
- 文件上传、图片粘贴和预览
- 使用量及额度重置时间
- 独立 Edge/Playwright 浏览器工具
- 24 小时免重复登录
- PWA 主屏安装和手机、iPad、电脑响应式布局
- 通过 GitHub 自动检测新版本；托盘或远程 Web 可一键下载、校验、覆盖安装并自动重启

## 新电脑安装

### 准备

宿主电脑需要：

- Windows 10/11 x64
- 已安装并登录 Codex Windows App
- Microsoft Edge

手机、平板或另一台电脑不需要安装 Codex App，也不需要登录 GPT，只需浏览器和 Web 密码。

### 正式安装版（推荐）

1. 打开 [GitHub Releases](https://github.com/2909272751/codex-web-remote/releases)。
2. 下载 `CodexWebRemote-Setup-1.4.8-win-x64.exe`。
3. 双击安装程序，按提示完成安装。
4. 安装结束后会自动打开“Codex Web Remote”首次设置窗口。
5. 输入至少 8 位的 Web 密码，可选填 88frp 公网地址。
6. 点击“完成设置并启动”。
7. 本机打开 [http://127.0.0.1:18888](http://127.0.0.1:18888)。

安装完成后，程序会驻留在 Windows 托盘。可以随时启动、停止、重启服务，修改密码和端口，复制 88frp 配置或打开日志。

### 免安装版

1. 下载 `CodexWebRemote-Portable-1.4.8-win-x64.zip`。
2. 完整解压到固定目录。
3. 双击 `CodexWebRemote.exe`。
4. 完成首次设置。

不要直接在压缩包预览窗口中运行 EXE。

## 88frp

在 88frp 中新建 HTTP 或 HTTPS 隧道：

```text
本地地址：127.0.0.1
本地端口：18888
```

把 88frp 分配的公网地址填入托盘控制中心后，会生成供手机扫描的二维码。文件和图片上传使用同一个端口。

建议使用 HTTPS，并在控制中心启用“公网入口使用 HTTPS”。HTTP 可以使用基本对话功能，但移动设备的 PWA、剪贴板和部分浏览器能力会受限制。

## 手机和 iPad

- Android Chrome/Edge：浏览器菜单 →“添加到主屏幕”或“安装应用”。
- iPhone/iPad Safari：分享按钮 →“添加到主屏幕”。
- 支持横竖屏、软键盘安全区和触屏操作。

PWA 安装通常需要 HTTPS 公网入口；普通网页访问不要求安装 PWA。

## 软件更新

- 托盘控制中心每 6 小时通过 GitHub Releases 检查一次，也可以手动点击“检查软件更新”。
- 远程 Web 检测到新版本后会显示更新横幅；没有运行中任务和排队消息时，可以直接点击“立即更新”。
- 更新包和 `.sha256` 都从本项目 GitHub Release 下载，校验通过后才会安装。
- 更新会停止服务、覆盖当前安装目录并自动重启，通常只短暂断线；密码、端口、自启、88frp 和数据目录不会变化。
- 便携版能够提示新版本，但只有由 EXE 托盘启动的网关支持远程一键更新。

## 安全和数据

- Web 密码通过 Windows DPAPI 加密后保存在 `%LOCALAPPDATA%\CodexWebRemote\settings.json`。
- 服务数据和浏览器工具资料保存在 `%LOCALAPPDATA%\CodexWebRemote\data`。
- 上传文件保存在 `%USERPROFILE%\.codex\web-uploads`，默认保留七天。
- 默认监听 `127.0.0.1`，不会直接监听所有网卡。
- 默认拒绝上传 EXE、DLL、MSI、BAT、CMD、COM、SCR 和 PS1。
- 卸载程序不会删除 Codex 原始任务和聊天记录，也不会主动删除用户设置。

## 日常使用

- 桌面 Codex App 正在执行任务时，Web 会提示稍后重试。
- Web 获得控制权后可以继续现有任务或创建新任务。
- 不要同时从桌面 App 和 Web 可写模式发送消息。
- Web 浏览器工具使用独立 Edge 配置，不共享桌面 Codex App 中 Browser 的标签页和登录状态。

## 开发和构建

源码开发需要 Node.js 22+、pnpm、.NET 8 SDK 和 Inno Setup 6：

```powershell
pnpm install --frozen-lockfile
npm run check
dotnet build .\desktop\CodexWebRemote.Launcher\CodexWebRemote.Launcher.csproj -c Release
.\build-installer.ps1 -Version 1.4.8
```

安装器回归测试：

```powershell
.\scripts\installer-test.ps1 -SetupPath .\dist\CodexWebRemote-Setup-1.4.8-win-x64.exe
```

## 已知限制

- 当前宿主安装包为 Windows x64；远程浏览器设备不受此架构限制。
- Windows 当前无法启动官方 `codex remote-control` app-server daemon，因此浏览器能力由独立 Playwright/Edge 后端提供。
- 未签名安装包首次运行时可能出现 Windows SmartScreen 提示。
- Codex `app-server` 协议可能随版本变化，升级 `@openai/codex` 后需要重新运行测试。

## License

[MIT](LICENSE)
