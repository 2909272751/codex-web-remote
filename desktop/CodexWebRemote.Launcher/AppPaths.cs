namespace CodexWebRemote;

internal sealed class AppPaths
{
    public string AppRoot { get; }
    public string StateRoot { get; }
    public string SettingsFile => Path.Combine(StateRoot, "settings.json");
    public string DataRoot => Path.Combine(StateRoot, "data");
    public string LogFile => Path.Combine(StateRoot, "gateway.log");
    public string NodePath => Path.Combine(AppRoot, "runtime", "node.exe");
    public string ServerPath => Path.Combine(AppRoot, "server.mjs");
    public string ExecutablePath => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "CodexWebRemote.exe");

    public AppPaths()
    {
        AppRoot = Environment.GetEnvironmentVariable("CODEX_WEB_APP_ROOT") ?? AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        StateRoot = Environment.GetEnvironmentVariable("CODEX_WEB_STATE_ROOT") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexWebRemote");
        Directory.CreateDirectory(StateRoot);
        Directory.CreateDirectory(DataRoot);
    }
}
