using System.Diagnostics;
using System.Net;

namespace CodexWebRemote;

internal enum GatewayState { Stopped, Starting, Running, Stopping, Failed }

internal sealed class ServerManager : IDisposable
{
    private readonly AppPaths _paths;
    private readonly ConfigStore _config;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private Process? _process;
    private readonly object _logLock = new();
    public GatewayState State { get; private set; } = GatewayState.Stopped;
    public string Detail { get; private set; } = "尚未启动";
    public event Action? Changed;

    public ServerManager(AppPaths paths, ConfigStore config)
    {
        _paths = paths;
        _config = config;
    }

    public async Task<bool> StartAsync()
    {
        var settings = _config.Load();
        if (settings is null) { SetState(GatewayState.Failed, "请先完成首次设置"); return false; }
        if (!File.Exists(_paths.NodePath) || !File.Exists(_paths.ServerPath))
        {
            SetState(GatewayState.Failed, "运行文件不完整，请重新安装");
            return false;
        }
        if (_process is { HasExited: false })
        {
            if (await IsHealthyAsync(settings.Port))
            {
                SetState(GatewayState.Running, $"正在监听 127.0.0.1:{settings.Port}");
                return true;
            }
            AppendLog("Node process is alive but health check failed; restarting gateway process.");
            try
            {
                _process.Kill(true);
                await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (Exception ex) { AppendLog(ex.Message); }
            finally { _process.Dispose(); _process = null; }
        }

        if (await IsHealthyAsync(settings.Port))
        {
            SetState(GatewayState.Running, $"端口 {settings.Port} 已有网关运行");
            return true;
        }

        SetState(GatewayState.Starting, "正在启动后台服务…");
        try
        {
            var start = new ProcessStartInfo(_paths.NodePath, "server.mjs")
            {
                WorkingDirectory = _paths.AppRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.Environment["CODEX_WEB_PASSWORD"] = _config.UnprotectPassword(settings);
            start.Environment["CODEX_WEB_HOST"] = "127.0.0.1";
            start.Environment["CODEX_WEB_PORT"] = settings.Port.ToString();
            start.Environment["CODEX_WEB_SECURE_COOKIE"] = settings.SecureCookie ? "1" : "0";
            start.Environment["CODEX_WEB_SESSION_HOURS"] = "24";
            start.Environment["CODEX_WEB_DATA_DIR"] = _paths.DataRoot;
            start.Environment["CODEX_WEB_UPDATE_REQUEST_FILE"] = _paths.UpdateRequestFile;
            start.Environment["CODEX_WEB_LAUNCHER_PATH"] = _paths.ExecutablePath;
            _process = new Process { StartInfo = start, EnableRaisingEvents = true };
            _process.OutputDataReceived += (_, e) => AppendLog(e.Data);
            _process.ErrorDataReceived += (_, e) => AppendLog(e.Data);
            _process.Exited += (_, _) => SetState(State == GatewayState.Stopping ? GatewayState.Stopped : GatewayState.Failed, "后台服务已停止");
            if (!_process.Start()) throw new InvalidOperationException("无法启动 Node 进程");
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
            for (var i = 0; i < 40; i++)
            {
                await Task.Delay(250);
                if (_process.HasExited) break;
                if (await IsHealthyAsync(settings.Port)) { SetState(GatewayState.Running, $"正在监听 127.0.0.1:{settings.Port}"); return true; }
            }
            SetState(GatewayState.Failed, $"启动失败，请查看日志：{_paths.LogFile}");
        }
        catch (Exception ex)
        {
            AppendLog(ex.ToString());
            SetState(GatewayState.Failed, ex.Message);
        }
        return false;
    }

    public async Task StopAsync()
    {
        if (_process is null || _process.HasExited) { SetState(GatewayState.Stopped, "服务未运行"); return; }
        SetState(GatewayState.Stopping, "正在停止…");
        try
        {
            _process.Kill(true);
            await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(8));
        }
        catch (Exception ex) { AppendLog(ex.Message); }
        finally { _process?.Dispose(); _process = null; SetState(GatewayState.Stopped, "服务已停止"); }
    }

    public async Task RestartAsync() { await StopAsync(); await StartAsync(); }

    public async Task<bool> IsHealthyAsync(int port)
    {
        try
        {
            using var response = await _http.GetAsync($"http://127.0.0.1:{port}/api/session");
            return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private void SetState(GatewayState state, string detail)
    {
        State = state; Detail = detail; Changed?.Invoke();
    }

    private void AppendLog(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        lock (_logLock) File.AppendAllText(_paths.LogFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
    }

    public void Dispose()
    {
        try { if (_process is { HasExited: false }) _process.Kill(true); } catch { }
        _process?.Dispose();
        _http.Dispose();
    }
}
