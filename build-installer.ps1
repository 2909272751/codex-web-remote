param(
    [string]$Version = "1.3.0"
)

$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDirectory = Join-Path $ProjectDirectory "dist"
$stageDirectory = Join-Path $distDirectory ("installer-stage-" + [guid]::NewGuid().ToString("N"))
$publishDirectory = Join-Path $distDirectory "launcher-publish"
$deployDirectory = Join-Path $env:TEMP ("codex-web-installer-deploy-" + [guid]::NewGuid().ToString("N"))
$portablePath = Join-Path $distDirectory "CodexWebRemote-Portable-$Version-win-x64.zip"

if (-not (Test-Path -LiteralPath $distDirectory)) { New-Item -ItemType Directory -Path $distDirectory | Out-Null }
foreach ($target in @($publishDirectory, $portablePath, "$portablePath.sha256")) {
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($distDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to remove path outside dist: $resolved" }
    if ((Get-Item -LiteralPath $resolved).PSIsContainer) { Get-ChildItem -LiteralPath $resolved -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $_.IsReadOnly = $false } }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

dotnet publish (Join-Path $ProjectDirectory "desktop\CodexWebRemote.Launcher\CodexWebRemote.Launcher.csproj") -c Release -r win-x64 --self-contained true -o $publishDirectory
if ($LASTEXITCODE -ne 0) { throw "Launcher publish failed: $LASTEXITCODE" }

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$pnpmExe = if ($pnpm) { $pnpm.Source } else { $null }
$pnpmPrefix = @()
if (-not $pnpmExe) {
    $pnpmExe = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    $pnpmCli = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.cjs"
    if (-not (Test-Path -LiteralPath $pnpmExe) -or -not (Test-Path -LiteralPath $pnpmCli)) { throw "pnpm is required." }
    $pnpmPrefix = @($pnpmCli)
}
New-Item -ItemType Directory -Path $deployDirectory | Out-Null
$excludedDirectories = @(
    (Join-Path $ProjectDirectory "node_modules"),
    (Join-Path $ProjectDirectory "dist"),
    (Join-Path $ProjectDirectory ".git"),
    (Join-Path $ProjectDirectory ".runtime-data"),
    (Join-Path $ProjectDirectory "desktop\CodexWebRemote.Launcher\bin"),
    (Join-Path $ProjectDirectory "desktop\CodexWebRemote.Launcher\obj")
)
& robocopy.exe $ProjectDirectory $deployDirectory /E /XJ /R:1 /W:1 /XD $excludedDirectories /XF ".env.local" "*.log" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Source staging failed: $LASTEXITCODE" }
& $pnpmExe @pnpmPrefix --dir $deployDirectory --config.node-linker=hoisted install --prod --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Production dependency install failed: $LASTEXITCODE" }
foreach ($developmentPath in @(
    "desktop", "installer", "scripts", ".env.example", ".gitignore", "build-installer.ps1", "build-release.ps1",
    "install-autostart.ps1", "setup.ps1", "start-hidden.vbs", "start.ps1", "uninstall-autostart.ps1", "RELEASE_NOTES.md"
)) {
    $target = Join-Path $deployDirectory $developmentPath
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
Move-Item -LiteralPath $deployDirectory -Destination $stageDirectory

$launcher = Join-Path $publishDirectory "CodexWebRemote.exe"
if (-not (Test-Path -LiteralPath $launcher)) { throw "Published launcher is missing." }
Copy-Item -LiteralPath $launcher -Destination (Join-Path $stageDirectory "CodexWebRemote.exe")

$portableNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $portableNode)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "Node.js was not found." }
    $portableNode = $nodeCommand.Source
}
$runtimeDirectory = Join-Path $stageDirectory "runtime"
New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
Copy-Item -LiteralPath $portableNode -Destination (Join-Path $runtimeDirectory "node.exe")

foreach ($forbidden in @(".env.local", ".runtime-data", ".git")) {
    if (Get-ChildItem -Path $stageDirectory -Recurse -Force -Filter $forbidden -ErrorAction SilentlyContinue) { throw "Forbidden release content: $forbidden" }
}
$links = Get-ChildItem (Join-Path $stageDirectory "node_modules") -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
if ($links) { throw "Release dependencies contain directory links that cannot be archived safely." }

Compress-Archive -Path (Join-Path $stageDirectory "*") -DestinationPath $portablePath -CompressionLevel Optimal
$portableHash = (Get-FileHash -LiteralPath $portablePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$portablePath.sha256" -Value "$portableHash  $(Split-Path $portablePath -Leaf)" -Encoding ASCII

$isccCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
$iscc = $isccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 compiler was not found." }
$languageFile = Join-Path $distDirectory "ChineseSimplified.isl"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/ChineseSimplified.isl" -OutFile $languageFile -UseBasicParsing
& $iscc "/DStageDir=$stageDirectory" "/DMyAppVersion=$Version" "/DChineseLanguageFile=$languageFile" "/O$distDirectory" (Join-Path $ProjectDirectory "installer\CodexWebRemote.iss")
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed: $LASTEXITCODE" }

$setupPath = Join-Path $distDirectory "CodexWebRemote-Setup-$Version-win-x64.exe"
if (-not (Test-Path -LiteralPath $setupPath)) { throw "Setup executable is missing." }
$setupHash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$setupPath.sha256" -Value "$setupHash  $(Split-Path $setupPath -Leaf)" -Encoding ASCII

Write-Host "Installer: $setupPath"
Write-Host "Installer SHA256: $setupHash"
Write-Host "Portable: $portablePath"
Write-Host "Portable SHA256: $portableHash"
