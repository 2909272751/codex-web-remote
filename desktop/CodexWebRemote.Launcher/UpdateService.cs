using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace CodexWebRemote;

internal sealed record ReleaseInfo(string TagName, Version Version, string PageUrl, string SetupUrl, string HashUrl);
internal sealed record PreparedUpdate(string SetupPath, string HelperPath, ReleaseInfo Release);

internal sealed class UpdateService : IDisposable
{
    private const string LatestReleaseApi = "https://api.github.com/repos/2909272751/codex-web-remote/releases/latest";
    private const string LatestReleasePage = "https://github.com/2909272751/codex-web-remote/releases/latest";
    private readonly AppPaths _paths;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMinutes(20) };

    public Version CurrentVersion { get; } = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0);

    public UpdateService(AppPaths paths)
    {
        _paths = paths;
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("CodexWebRemote-Updater/1.0");
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
    }

    public async Task<ReleaseInfo?> CheckAsync(CancellationToken cancellationToken = default)
    {
        var api = Environment.GetEnvironmentVariable("CODEX_WEB_UPDATE_API") ?? LatestReleaseApi;
        using var response = await _http.GetAsync(api, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Forbidden or (HttpStatusCode)429)
            return await CheckFromPublicReleasePageAsync(cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        if (root.TryGetProperty("draft", out var draft) && draft.GetBoolean()) return null;
        if (root.TryGetProperty("prerelease", out var prerelease) && prerelease.GetBoolean()) return null;
        var tag = root.GetProperty("tag_name").GetString() ?? "";
        if (!TryParseVersion(tag, out var version)) return null;
        var page = root.TryGetProperty("html_url", out var pageElement) ? pageElement.GetString() ?? "" : "";
        string setup = "", hash = "";
        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString() ?? "";
            var url = asset.GetProperty("browser_download_url").GetString() ?? "";
            if (name.EndsWith("-win-x64.exe", StringComparison.OrdinalIgnoreCase) && name.Contains("Setup", StringComparison.OrdinalIgnoreCase)) setup = url;
            if (name.EndsWith("-win-x64.exe.sha256", StringComparison.OrdinalIgnoreCase) && name.Contains("Setup", StringComparison.OrdinalIgnoreCase)) hash = url;
        }
        return string.IsNullOrWhiteSpace(setup) || string.IsNullOrWhiteSpace(hash) ? null : new ReleaseInfo(tag, version, page, setup, hash);
    }

    private async Task<ReleaseInfo?> CheckFromPublicReleasePageAsync(CancellationToken cancellationToken)
    {
        var pageUrl = Environment.GetEnvironmentVariable("CODEX_WEB_UPDATE_PAGE") ?? LatestReleasePage;
        using var response = await _http.GetAsync(pageUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var page = response.RequestMessage?.RequestUri?.ToString() ?? pageUrl;
        var tag = page.Split("/releases/tag/", StringSplitOptions.None).LastOrDefault()?.Split('?', '#')[0] ?? "";
        if (!TryParseVersion(tag, out var version)) return null;
        var normalizedTag = tag.Trim();
        var baseUrl = $"https://github.com/2909272751/codex-web-remote/releases/download/{normalizedTag}";
        var setup = $"{baseUrl}/CodexWebRemote-Setup-{version}-win-x64.exe";
        var hash = $"{setup}.sha256";
        return new ReleaseInfo(normalizedTag, version, page, setup, hash);
    }

    public bool IsNewer(ReleaseInfo release) => release.Version > CurrentVersion;

    public async Task<PreparedUpdate> DownloadAsync(ReleaseInfo release, IProgress<int>? progress = null, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(_paths.UpdatesRoot);
        var setupPath = Path.Combine(_paths.UpdatesRoot, $"CodexWebRemote-Setup-{release.Version}-win-x64.exe");
        var tempPath = setupPath + ".download";
        using (var response = await _http.GetAsync(release.SetupUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
        {
            response.EnsureSuccessStatusCode();
            var total = response.Content.Headers.ContentLength;
            await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var target = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 128, true);
            var buffer = new byte[1024 * 128];
            long copied = 0;
            while (true)
            {
                var read = await source.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                copied += read;
                if (total > 0) progress?.Report((int)Math.Clamp(copied * 100 / total.Value, 0, 100));
            }
        }
        File.Move(tempPath, setupPath, true);
        var hashText = await _http.GetStringAsync(release.HashUrl, cancellationToken);
        var expected = hashText.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        await using (var file = File.OpenRead(setupPath))
        {
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(file, cancellationToken));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(setupPath);
                throw new InvalidDataException("更新包 SHA256 校验失败，已取消安装。");
            }
        }
        var helperPath = Path.Combine(_paths.UpdatesRoot, "CodexWebRemote.Updater.exe");
        File.Copy(_paths.ExecutablePath, helperPath, true);
        return new PreparedUpdate(setupPath, helperPath, release);
    }

    internal static bool TryParseVersion(string tag, out Version version)
    {
        var normalized = tag.Trim().TrimStart('v', 'V').Split('-', '+')[0];
        return Version.TryParse(normalized, out version!);
    }

    public void Dispose() => _http.Dispose();
}

internal static class UpdateApplier
{
    internal static ProcessStartInfo CreateSilentInstallerStartInfo(string setupPath, string installRoot)
    {
        var start = new ProcessStartInfo(setupPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = Path.GetDirectoryName(setupPath) ?? Environment.CurrentDirectory,
        };
        start.ArgumentList.Add("/VERYSILENT");
        start.ArgumentList.Add("/SUPPRESSMSGBOXES");
        start.ArgumentList.Add("/SP-");
        start.ArgumentList.Add("/NORESTART");
        start.ArgumentList.Add($"/DIR={installRoot}");
        return start;
    }

    public static int Run(string setupPath, string installRoot, int parentPid)
    {
        try
        {
            try
            {
                using var parent = Process.GetProcessById(parentPid);
                parent.WaitForExit(90_000);
            }
            catch (ArgumentException) { }

            var start = CreateSilentInstallerStartInfo(setupPath, installRoot);
            using var installer = Process.Start(start) ?? throw new InvalidOperationException("无法启动更新安装包");
            installer.WaitForExit();
            if (installer.ExitCode != 0) return installer.ExitCode;

            var installedLauncher = Path.Combine(installRoot, "CodexWebRemote.exe");
            var restart = new ProcessStartInfo(installedLauncher)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = installRoot,
            };
            restart.ArgumentList.Add("--background");
            Process.Start(restart);
            return 0;
        }
        catch { return 1; }
    }
}
