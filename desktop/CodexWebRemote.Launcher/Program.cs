using System.Diagnostics;
using System.Threading;

namespace CodexWebRemote;

internal static class Program
{
    private const string MutexName = "Local\\CodexWebRemote.Launcher";
    private const string ShowEventName = "Local\\CodexWebRemote.Show";
    private const string ShutdownEventName = "Local\\CodexWebRemote.Shutdown";

    [STAThread]
    private static void Main(string[] args)
    {
        var applyIndex = Array.FindIndex(args, value => value.Equals("--apply-update", StringComparison.OrdinalIgnoreCase));
        if (applyIndex >= 0 && args.Length >= applyIndex + 4)
        {
            Environment.ExitCode = int.TryParse(args[applyIndex + 3], out var parentPid)
                ? UpdateApplier.Run(args[applyIndex + 1], args[applyIndex + 2], parentPid)
                : 1;
            return;
        }
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            Environment.ExitCode = RunSelfTest();
            return;
        }
        if (args.Contains("--account-switch-list", StringComparer.OrdinalIgnoreCase) || args.Contains("--account-switch-activate", StringComparer.OrdinalIgnoreCase))
        {
            Environment.ExitCode = AccountSwitcher.Run(args);
            return;
        }
        if (args.Contains("--ui-snapshot", StringComparer.OrdinalIgnoreCase))
        {
            RunUiSnapshot();
            return;
        }

        if (args.Contains("--shutdown", StringComparer.OrdinalIgnoreCase))
        {
            SignalExisting(ShutdownEventName);
            return;
        }

        using var mutex = new Mutex(true, MutexName, out var ownsMutex);
        if (!ownsMutex)
        {
            SignalExisting(ShowEventName);
            return;
        }

        ApplicationConfiguration.Initialize();
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        using var shutdownEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShutdownEventName);
        var paths = new AppPaths();
        var config = new ConfigStore(paths);
        using var server = new ServerManager(paths, config);
        using var form = new MainForm(paths, config, server, args.Contains("--background", StringComparer.OrdinalIgnoreCase));
        var showWait = ThreadPool.RegisterWaitForSingleObject(showEvent, (_, _) => form.SafeShow(), null, Timeout.Infinite, false);
        var shutdownWait = ThreadPool.RegisterWaitForSingleObject(shutdownEvent, (_, _) => form.SafeExit(), null, Timeout.Infinite, false);
        try { Application.Run(form); }
        finally { showWait.Unregister(null); shutdownWait.Unregister(null); }
    }

    private static void SignalExisting(string name)
    {
        try { EventWaitHandle.OpenExisting(name).Set(); }
        catch (WaitHandleCannotBeOpenedException) { }
    }

    private static int RunSelfTest()
    {
        try
        {
            var stateRoot = Path.Combine(Path.GetTempPath(), "CodexWebRemote.SelfTest", Guid.NewGuid().ToString("N"));
            Environment.SetEnvironmentVariable("CODEX_WEB_STATE_ROOT", stateRoot);
            var paths = new AppPaths();
            var config = new ConfigStore(paths);
            var port = int.TryParse(Environment.GetEnvironmentVariable("CODEX_WEB_SELF_TEST_PORT"), out var parsed) ? parsed : 18992;
            config.Save("codex-web-self-test", port, false, false, applyAutoStart: false);
            using var server = new ServerManager(paths, config);
            if (!server.StartAsync().GetAwaiter().GetResult()) return 2;
            if (!server.IsHealthyAsync(port).GetAwaiter().GetResult()) return 3;
            server.StopAsync().GetAwaiter().GetResult();
            if (!UpdateService.TryParseVersion("v99.8.7", out var updateVersion) || updateVersion != new Version(99, 8, 7)) return 4;
            var silent = UpdateApplier.CreateSilentInstallerStartInfo("C:\\temp\\CodexWebRemote-Setup.exe", "D:\\CodexWebRemote");
            if (silent.UseShellExecute || !silent.CreateNoWindow || silent.WindowStyle != ProcessWindowStyle.Hidden) return 5;
            var requiredArgs = new[] { "/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-", "/NORESTART", "/DIR=D:\\CodexWebRemote" };
            if (!requiredArgs.All(value => silent.ArgumentList.Contains(value))) return 6;
            return 0;
        }
        catch { return 1; }
    }

    private static void RunUiSnapshot()
    {
        ApplicationConfiguration.Initialize();
        var paths = new AppPaths();
        var config = new ConfigStore(paths);
        using var server = new ServerManager(paths, config);
        using var form = new MainForm(paths, config, server, false);
        var output = Environment.GetEnvironmentVariable("CODEX_WEB_SNAPSHOT_PATH") ?? Path.Combine(paths.StateRoot, "launcher.png");
        var timer = new System.Windows.Forms.Timer { Interval = 1200 };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            using var bitmap = new Bitmap(form.Width, form.Height);
            form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
            form.SafeExit();
        };
        form.Shown += (_, _) => timer.Start();
        Application.Run(form);
        timer.Dispose();
    }
}
