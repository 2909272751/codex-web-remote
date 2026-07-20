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

$uninstaller = Start-Process -FilePath (Join-Path $install "unins000.exe") -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -WindowStyle Hidden -PassThru -Wait
if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstaller.ExitCode)" }
Start-Sleep -Seconds 2

$taskAfter = (Get-ScheduledTask -TaskName "Codex Web Remote" -ErrorAction SilentlyContinue).State
$production = Invoke-WebRequest "http://127.0.0.1:18888/api/session" -UseBasicParsing -TimeoutSec 10
[pscustomobject]@{
    QaRoot = $qaRoot
    InstallerExit = $installer.ExitCode
    SelfTestExit = $test.ExitCode
    UninstallerExit = $uninstaller.ExitCode
    InstallRemoved = -not (Test-Path -LiteralPath $install)
    SettingsPreserved = Test-Path -LiteralPath (Join-Path $state "settings.json")
    TaskBefore = $taskBefore
    TaskAfter = $taskAfter
    ProductionHttp = $production.StatusCode
}
