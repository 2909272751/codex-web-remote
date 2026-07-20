using Microsoft.Win32;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CodexWebRemote;

internal sealed record AppSettings(string ProtectedPassword, int Port = 18888, bool SecureCookie = false, bool AutoStart = true, string PublicUrl = "")
{
    public string Url => $"http://127.0.0.1:{Port}";
    public string QrUrl => string.IsNullOrWhiteSpace(PublicUrl) ? Url : PublicUrl.Trim();
}

internal sealed class ConfigStore
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "Codex Web Remote";
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("CodexWebRemote.Settings.v1");
    private readonly AppPaths _paths;

    public ConfigStore(AppPaths paths) => _paths = paths;

    public bool Exists => File.Exists(_paths.SettingsFile);

    public AppSettings? Load()
    {
        try { return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_paths.SettingsFile)); }
        catch { return null; }
    }

    public string UnprotectPassword(AppSettings settings)
    {
        var encrypted = Convert.FromBase64String(settings.ProtectedPassword);
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser));
    }

    public AppSettings Save(string password, int port, bool secureCookie, bool autoStart, string publicUrl = "", bool applyAutoStart = true)
    {
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(password), Entropy, DataProtectionScope.CurrentUser);
        var settings = new AppSettings(Convert.ToBase64String(encrypted), port, secureCookie, autoStart, publicUrl.Trim());
        var temp = _paths.SettingsFile + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, _paths.SettingsFile, true);
        if (applyAutoStart) SetAutoStart(autoStart);
        return settings;
    }

    public void SetAutoStart(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) key.SetValue(RunValue, $"\"{_paths.ExecutablePath}\" --background");
        else key.DeleteValue(RunValue, false);
    }
}
