using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CodexWebRemote;

// Reads only the metadata in account-switcher's index.  The encrypted profile
// itself is decrypted locally with the current Windows user's DPAPI key and is
// never returned to the browser or written to logs.
internal static class AccountSwitcher
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("CodexAccountSwitcher-v1");

    public static int Run(string[] args)
    {
        try
        {
            var root = ResolveCodexRoot();
            var profileRoot = Path.Combine(root, "account-switcher", "profiles");
            var indexFile = Path.Combine(root, "account-switcher", "index.json");
            var index = ReadIndex(indexFile);
            var profiles = index.Profiles ?? [];
            if (args.Contains("--account-switch-list", StringComparer.OrdinalIgnoreCase))
            {
                Write(new { ok = true, profiles = profiles.Select(profile => new { id = profile.Id, label = DisplayLabel(profile), hint = SafeHint(profile.IdentityHint) }) });
                return 0;
            }

            var activateIndex = Array.FindIndex(args, value => value.Equals("--account-switch-activate", StringComparison.OrdinalIgnoreCase));
            if (activateIndex < 0 || activateIndex + 1 >= args.Length) return 2;
            var id = args[activateIndex + 1];
            var selected = profiles.FirstOrDefault(profile => string.Equals(profile.Id, id, StringComparison.OrdinalIgnoreCase));
            if (selected is null) throw new InvalidOperationException("找不到所选账号档案。");
            if (!IsSafeId(selected.Id)) throw new InvalidOperationException("账号档案标识无效。");
            var encrypted = File.ReadAllBytes(Path.Combine(profileRoot, $"{selected.Id}.dat"));
            var plain = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            try
            {
                if (plain.Length < 2 || plain[0] != (byte)'{' || plain[^1] != (byte)'}') throw new InvalidOperationException("账号档案内容无效。");
                Directory.CreateDirectory(root);
                var destination = Path.Combine(root, "auth.json");
                var temporary = Path.Combine(root, $"auth.{Guid.NewGuid():N}.tmp");
                try
                {
                    File.WriteAllBytes(temporary, plain);
                    File.Move(temporary, destination, true);
                }
                finally
                {
                    if (File.Exists(temporary)) File.Delete(temporary);
                }
            }
            finally { CryptographicOperations.ZeroMemory(plain); }
            index.ActiveProfileId = selected.Id;
            WriteIndex(indexFile, index);
            Write(new { ok = true, profile = new { id = selected.Id, label = DisplayLabel(selected), hint = SafeHint(selected.IdentityHint) } });
            return 0;
        }
        catch (Exception error)
        {
            Write(new { ok = false, error = error.Message });
            return 1;
        }
    }

    private static string ResolveCodexRoot() => Environment.GetEnvironmentVariable("CODEX_HOME")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");

    private static AccountIndex ReadIndex(string indexFile)
    {
        if (!File.Exists(indexFile)) return new AccountIndex();
        var index = JsonSerializer.Deserialize<AccountIndex>(File.ReadAllText(indexFile), JsonOptions) ?? new AccountIndex();
        index.Profiles = (index.Profiles ?? []).Where(profile => !string.IsNullOrWhiteSpace(profile.Id)).ToList();
        return index;
    }

    private static void WriteIndex(string indexFile, AccountIndex index)
    {
        var temporary = $"{indexFile}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(index, JsonOptions));
            File.Move(temporary, indexFile, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static bool IsSafeId(string id) => id.Length is > 5 and <= 80 && id.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
    private static string DisplayLabel(AccountProfile profile) => string.IsNullOrWhiteSpace(profile.Label) ? "未命名账号" : profile.Label.Trim()[..Math.Min(80, profile.Label.Trim().Length)];
    private static string SafeHint(string? hint) => string.IsNullOrWhiteSpace(hint) ? "" : hint.Trim()[..Math.Min(120, hint.Trim().Length)];
    private static void Write(object value) => Console.Out.Write(JsonSerializer.Serialize(value, JsonOptions));
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private sealed class AccountIndex { public string? ActiveProfileId { get; set; } public List<AccountProfile>? Profiles { get; set; } [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; } }
    private sealed class AccountProfile { public string Id { get; set; } = ""; public string? Label { get; set; } public string? IdentityHint { get; set; } [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; set; } }
}
