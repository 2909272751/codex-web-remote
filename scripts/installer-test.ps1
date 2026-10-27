param(
    [Parameter(Mandatory = $true)][string]$SetupPath
)

$ErrorActionPreference = "Stop"
$qaRoot = Join-Path $env:TEMP ("codex-web-setup-qa-" + [guid]::NewGuid().ToString("N"))
$install = Join-Path $qaRoot "app"
$state = Join-Path $qaRoot "state"
New-Item -ItemType Directory -Path $qaRoot, $state | Out-Null
if (-not $qaRoot.StartsWith($env:TEMP, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe QA root: $qaRoot" }

$taskBefore = (Get-ScheduledTask -TaskName "Codex Web Remote" -ErrorAction SilentlyContinue).State
$runBefore = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue).'Codex Web Remote'
$installerArgs = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/QA=1", "/DIR=$install")
$installer = Start-Process -FilePath $SetupPath -ArgumentList $installerArgs -WindowStyle Hidden -PassThru -Wait
if ($installer.ExitCode -ne 0) { throw "Installer failed: $($installer.ExitCode)" }

foreach ($required in @("CodexWebRemote.exe", "server.mjs", "runtime\node.exe", "node_modules\@openai\codex\bin\codex.js", "public\manifest.webmanifest")) {
    if (-not (Test-Path -LiteralPath (Join-Path $install $required))) { throw "Missing installed file: $required" }
}

$env:CODEX_WEB_STATE_ROOT = $state
$env:CODEX_WEB_SELF_TEST_PORT = "18994"
try {
    $test = Start-Process -FilePath (Join-Path $install "CodexWebRemote.exe") -ArgumentList "--self-test" -WindowStyle Hidden -PassThru -Wait
    if ($test.ExitCode -ne 0) { throw "Installed launcher self-test failed: $($test.ExitCode)" }
} finally {
    Remove-Item Env:CODEX_WEB_STATE_ROOT, Env:CODEX_WEB_SELF_TEST_PORT -ErrorAction SilentlyContinue
}

# Regression: an overwrite install WITHOUT /DIR must reuse the directory of the
# installation that is already registered, never the DefaultDirName fallback.
# A missing uninstall entry used to make Inno treat the upgrade as a fresh
# install and silently create a second instance. Runs before the uninstall so
# the QA install is still the registered one (this stays inside the QA root).
$defaultDir = Join-Path $env:LOCALAPPDATA "Programs\CodexWebRemote"
$defaultDirExistedBefore = Test-Path -LiteralPath $defaultDir
$reinstallLog = Join-Path $qaRoot "reinstall.log"
$reinstallArgs = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/QA=1", "/LOG=$reinstallLog")
$reinstall = Start-Process -FilePath $SetupPath -ArgumentList $reinstallArgs -WindowStyle Hidden -PassThru -Wait
$reusedDir = $null
if (Test-Path -LiteralPath $reinstallLog) {
    $match = Select-String -LiteralPath $reinstallLog -Pattern 'Dest filename: (.+?)\\CodexWebRemote\.exe' | Select-Object -First 1
    if ($match) { $reusedDir = $match.Matches[0].Groups[1].Value }
}
$secondInstanceCreated = (-not $defaultDirExistedBefore) -and (Test-Path -LiteralPath $defaultDir)

$uninstaller = Start-Process -FilePath (Join-Path $install "unins000.exe") -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -WindowStyle Hidden -PassThru -Wait
if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstaller.ExitCode)" }
Start-Sleep -Seconds 2

$taskAfter = (Get-ScheduledTask -TaskName "Codex Web Remote" -ErrorAction SilentlyContinue).State
$runAfter = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue).'Codex Web Remote'
[pscustomobject]@{
    QaRoot = $qaRoot
    InstallerExit = $installer.ExitCode
    SelfTestExit = $test.ExitCode
    UninstallerExit = $uninstaller.ExitCode
    InstallRemoved = -not (Test-Path -LiteralPath $install)
    SettingsPreserved = Test-Path -LiteralPath (Join-Path $state "settings.json")
    TaskBefore = $taskBefore
    TaskAfter = $taskAfter
    AutoStartPreserved = $runBefore -eq $runAfter
    ReinstallExit = $reinstall.ExitCode
    ReinstallReusedDir = $reusedDir
    ReinstallReusedQaDir = [bool]($reusedDir -and ($reusedDir.TrimEnd('\') -ieq $install.TrimEnd('\')))
    SecondInstanceCreated = $secondInstanceCreated
}
