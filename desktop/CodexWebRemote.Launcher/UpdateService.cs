using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace CodexWebRemote;

internal sealed record ReleaseInfo(string TagName, Version Version, string PageUrl, string PackageUrl, string HashUrl);
internal sealed record PreparedUpdate(string StagingPath, string HelperPath, ReleaseInfo Release);

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
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("CodexWebRemote-Updater/2.0");
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
        string package = "", hash = "";
        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString() ?? "";
            var url = asset.GetProperty("browser_download_url").GetString() ?? "";
            if (name.EndsWith("-win-x64.zip", StringComparison.OrdinalIgnoreCase) && name.Contains("Portable", StringComparison.OrdinalIgnoreCase)) package = url;
            if (name.EndsWith("-win-x64.zip.sha256", StringComparison.OrdinalIgnoreCase) && name.Contains("Portable", StringComparison.OrdinalIgnoreCase)) hash = url;
        }
        return string.IsNullOrWhiteSpace(package) || string.IsNullOrWhiteSpace(hash)
            ? null
            : new ReleaseInfo(tag, version, page, package, hash);
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
        var package = $"{baseUrl}/CodexWebRemote-Portable-{version}-win-x64.zip";
        return new ReleaseInfo(normalizedTag, version, page, package, $"{package}.sha256");
    }

    public bool IsNewer(ReleaseInfo release) => release.Version > CurrentVersion;

    public async Task<PreparedUpdate> DownloadAsync(ReleaseInfo release, IProgress<int>? progress = null, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(_paths.UpdatesRoot);
        CleanupOldDownloads();
        var archivePath = Path.Combine(_paths.UpdatesRoot, $"CodexWebRemote-Portable-{release.Version}-win-x64.zip");
        var tempPath = archivePath + ".download";
        using (var response = await _http.GetAsync(release.PackageUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
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
        File.Move(tempPath, archivePath, true);
        var hashText = await _http.GetStringAsync(release.HashUrl, cancellationToken);
        var expected = hashText.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        await using (var file = File.OpenRead(archivePath))
        {
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(file, cancellationToken));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(archivePath);
                throw new InvalidDataException("更新包 SHA256 校验失败，已取消更新。");
            }
        }

        var installParent = Directory.GetParent(_paths.AppRoot)?.FullName
            ?? throw new InvalidOperationException("无法确定程序安装目录。");
        var stagingContainer = Path.Combine(installParent, $"{Path.GetFileName(_paths.AppRoot)}.update-{release.Version}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(stagingContainer);
        try
        {
            ZipFile.ExtractToDirectory(archivePath, stagingContainer, true);
            var stagingPath = ResolvePayloadRoot(stagingContainer);
            if (!UpdateApplier.ValidatePayload(stagingPath)) throw new InvalidDataException("更新包内容不完整，已取消更新。");
            var helperPath = Path.Combine(_paths.UpdatesRoot, "CodexWebRemote.Updater.exe");
            File.Copy(_paths.ExecutablePath, helperPath, true);
            return new PreparedUpdate(stagingPath, helperPath, release);
        }
        catch
        {
            try { Directory.Delete(stagingContainer, true); } catch { }
            throw;
        }
    }

    private static string ResolvePayloadRoot(string stagingContainer)
    {
        if (UpdateApplier.ValidatePayload(stagingContainer)) return stagingContainer;
        var directories = Directory.GetDirectories(stagingContainer);
        return directories.Length == 1 && UpdateApplier.ValidatePayload(directories[0]) ? directories[0] : stagingContainer;
    }

    private void CleanupOldDownloads()
    {
        foreach (var file in Directory.GetFiles(_paths.UpdatesRoot, "CodexWebRemote-Portable-*-win-x64.zip*"))
        {
            try { File.Delete(file); } catch { }
        }
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
    private static readonly string[] RequiredPayloadFiles =
    {
        "CodexWebRemote.exe",
        "server.mjs",
        @"runtime\node.exe",
        @"node_modules\@openai\codex\bin\codex.js",
        @"public\manifest.webmanifest",
    };

    internal static bool ValidatePayload(string root) =>
        !string.IsNullOrWhiteSpace(root) && Directory.Exists(root) &&
        RequiredPayloadFiles.All(relative => File.Exists(Path.Combine(root, relative)));

    internal static bool RunSwapSelfTest(string root)
    {
        try
        {
            var installRoot = Path.Combine(root, "CodexWebRemote");
            var stagingRoot = Path.Combine(root, "CodexWebRemote.update-self-test");
            var backupRoot = installRoot + ".previous";
            Directory.CreateDirectory(installRoot);
            File.WriteAllText(Path.Combine(installRoot, "obsolete-file.txt"), "old");
            foreach (var relative in RequiredPayloadFiles)
            {
                var file = Path.Combine(stagingRoot, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                File.WriteAllText(file, "new");
            }
            File.WriteAllText(Path.Combine(stagingRoot, "new-file.txt"), "new");
            MoveDirectoryWithRetry(installRoot, backupRoot);
            MoveDirectoryWithRetry(stagingRoot, installRoot);
            var valid = ValidatePayload(installRoot) &&
                File.Exists(Path.Combine(installRoot, "new-file.txt")) &&
                !File.Exists(Path.Combine(installRoot, "obsolete-file.txt")) &&
                Directory.Exists(backupRoot);
            DeleteDirectoryWithRetry(backupRoot);
            DeleteDirectoryWithRetry(installRoot);
            DeleteDirectoryWithRetry(root);
            return valid && !Directory.Exists(root);
        }
        catch
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
            return false;
        }
    }

    public static int Run(string stagingPath, string installRoot, int parentPid)
    {
        var backupRoot = installRoot.TrimEnd(Path.DirectorySeparatorChar) + ".previous";
        var stagingContainer = FindStagingContainer(stagingPath, installRoot);
        var movedOldInstall = false;
        try
        {
            try
            {
                using var parent = Process.GetProcessById(parentPid);
                parent.WaitForExit(90_000);
            }
            catch (ArgumentException) { }

            if (!ValidatePayload(stagingPath)) throw new InvalidDataException("更新暂存目录内容不完整。");
            PreserveUninstaller(installRoot, stagingPath);
            if (Directory.Exists(backupRoot)) Directory.Delete(backupRoot, true);
            MoveDirectoryWithRetry(installRoot, backupRoot);
            movedOldInstall = true;
            MoveDirectoryWithRetry(stagingPath, installRoot);

            var installedLauncher = Path.Combine(installRoot, "CodexWebRemote.exe");
            using var selfTest = Process.Start(CreateLauncherStartInfo(installedLauncher, "--self-test"))
                ?? throw new InvalidOperationException("无法验证更新后的程序。");
            if (!selfTest.WaitForExit(120_000) || selfTest.ExitCode != 0)
                throw new InvalidOperationException("更新后的程序自检失败。");

            Process.Start(CreateLauncherStartInfo(installedLauncher, "--background"));
            try { DeleteDirectoryWithRetry(backupRoot); } catch { }
            CleanupStagingContainer(stagingContainer, installRoot);
            CleanupUpdateDownloads();
            return 0;
        }
        catch
        {
            try
            {
                if (movedOldInstall && Directory.Exists(backupRoot))
                {
                    if (Directory.Exists(installRoot)) DeleteDirectoryWithRetry(installRoot);
                    MoveDirectoryWithRetry(backupRoot, installRoot);
                }
                var launcher = Path.Combine(installRoot, "CodexWebRemote.exe");
                if (File.Exists(launcher)) Process.Start(CreateLauncherStartInfo(launcher, "--background"));
            }
            catch { }
            return 1;
        }
    }

    private static ProcessStartInfo CreateLauncherStartInfo(string executable, string argument)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = Path.GetDirectoryName(executable) ?? Environment.CurrentDirectory,
        };
        start.ArgumentList.Add(argument);
        start.Environment["CODEX_WEB_SELF_TEST_PORT"] = Random.Shared.Next(19000, 24000).ToString();
        return start;
    }

    private static void PreserveUninstaller(string installRoot, string stagingPath)
    {
        if (!Directory.Exists(installRoot)) return;
        foreach (var pattern in new[] { "unins*.exe", "unins*.dat", "unins*.msg" })
            foreach (var file in Directory.GetFiles(installRoot, pattern, SearchOption.TopDirectoryOnly))
                File.Copy(file, Path.Combine(stagingPath, Path.GetFileName(file)), true);
    }

    private static void CleanupStagingContainer(string? stagingContainer, string installRoot)
    {
        if (string.IsNullOrWhiteSpace(stagingContainer) || !Directory.Exists(stagingContainer)) return;
        var installParent = Directory.GetParent(Path.GetFullPath(installRoot))?.FullName;
        var stagingParent = Directory.GetParent(Path.GetFullPath(stagingContainer))?.FullName;
        var expectedPrefix = Path.GetFileName(installRoot) + ".update-";
        if (!string.Equals(installParent, stagingParent, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(stagingContainer).StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase)) return;
        try { DeleteDirectoryWithRetry(stagingContainer); } catch { }
    }

    private static string? FindStagingContainer(string stagingPath, string installRoot)
    {
        var expectedPrefix = Path.GetFileName(installRoot) + ".update-";
        var installParent = Directory.GetParent(Path.GetFullPath(installRoot))?.FullName;
        for (var current = new DirectoryInfo(Path.GetFullPath(stagingPath)); current is not null; current = current.Parent)
        {
            if (string.Equals(current.Parent?.FullName, installParent, StringComparison.OrdinalIgnoreCase) &&
                current.Name.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase)) return current.FullName;
            if (string.Equals(current.FullName, installParent, StringComparison.OrdinalIgnoreCase)) break;
        }
        return null;
    }

    private static void CleanupUpdateDownloads()
    {
        try
        {
            var updatesRoot = AppContext.BaseDirectory;
            foreach (var file in Directory.GetFiles(updatesRoot, "CodexWebRemote-Portable-*-win-x64.zip*"))
                try { File.Delete(file); } catch { }
        }
        catch { }
    }

    private static void MoveDirectoryWithRetry(string source, string destination)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 12; attempt++)
        {
            try
            {
                Directory.Move(source, destination);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                last = error;
                Thread.Sleep(attempt * 250);
            }
        }
        throw last ?? new IOException($"无法替换目录：{source}");
    }

    private static void DeleteDirectoryWithRetry(string path)
    {
        if (!Directory.Exists(path)) return;
        Exception? last = null;
        for (var attempt = 1; attempt <= 12; attempt++)
        {
            try
            {
                Directory.Delete(path, true);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                last = error;
                Thread.Sleep(attempt * 250);
            }
        }
        throw last ?? new IOException($"无法清理目录：{path}");
    }
}
