# Codex Web Remote v1.1.1

这是一个接管启动兼容性修复版本。

## 修复

- 修复新电脑没有 `node_repl` 和 `openaiDeveloperDocs` MCP 配置时，接管会报 `Codex app-server stopped (code=1, signal=none)` 的问题。
- app-server 意外退出时，网页错误和托盘日志现在会显示退出前的真实错误，便于排查不同电脑上的环境问题。
- 新增干净 Codex 配置回归测试，确保安装包不依赖开发电脑独有的配置。

## 安装

已安装 v1.1.0 的电脑直接运行 v1.1.1 安装包覆盖升级即可，密码、端口和 88frp 地址会保留。

---

## v1.1.0

本版本将安装和日常管理改成完全图形化流程，普通用户不再需要 PowerShell、Node.js 或命令行。

## 新功能

- 中文 `Setup.exe`，双击后按安装向导完成安装
- 原生 Windows 首次设置界面
- 托盘控制中心：启动、停止、重启、打开网页和查看日志
- 密码使用 Windows DPAPI 加密保存
- 图形化修改密码、端口、HTTPS Cookie 和开机启动
- 88frp 配置提示、公网地址保存和二维码
- PWA 支持，可在手机和 iPad 添加到主屏幕
- 配置与程序文件分离，覆盖升级不会丢失设置
- 标准卸载流程，卸载不会删除 Codex 原始任务

## 安装

1. 安装并登录 Codex Windows App，确认能正常打开任务。
2. 下载 `CodexWebRemote-Setup-1.1.1-win-x64.exe`。
3. 双击安装，安装完成后会自动打开首次设置界面。
4. 设置 Web 密码，点击“完成设置并启动”。
5. 本机打开 `http://127.0.0.1:18888`；远程访问时，将 88frp 指向 `127.0.0.1:18888`。

免安装用户可以下载 `CodexWebRemote-Portable-1.1.1-win-x64.zip`，解压后双击 `CodexWebRemote.exe`。
