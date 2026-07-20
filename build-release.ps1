param(
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDirectory = Join-Path $ProjectDirectory "dist"
$packageName = "codex-web-remote-v$Version-windows-x64"
$stageDirectory = Join-Path $distDirectory $packageName
$deployDirectory = Join-Path $env:TEMP ("codex-web-remote-deploy-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $distDirectory "$packageName.zip"
$checksumPath = "$archivePath.sha256"

if (-not (Test-Path -LiteralPath $distDirectory)) {
    New-Item -ItemType Directory -Path $distDirectory | Out-Null
}

foreach ($target in @($stageDirectory, $archivePath, $checksumPath)) {
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($distDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside dist: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) { throw "pnpm.cmd is required to build the release package." }
& $pnpm.Source --config.node-linker=hoisted --filter codex-web-remote deploy --prod --legacy $deployDirectory
if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed with exit code $LASTEXITCODE" }
$deployedModules = Join-Path $deployDirectory "node_modules"
if (Test-Path -LiteralPath $deployedModules) {
    Remove-Item -LiteralPath $deployedModules -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $ProjectDirectory "pnpm-lock.yaml") -Destination (Join-Path $deployDirectory "pnpm-lock.yaml")
& $pnpm.Source --dir $deployDirectory --config.node-linker=hoisted install --prod --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
Move-Item -LiteralPath $deployDirectory -Destination $stageDirectory

$reparsePoints = Get-ChildItem (Join-Path $stageDirectory "node_modules") -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
if ($reparsePoints) { throw "Release node_modules still contains links that cannot be safely archived." }

$portableNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $portableNode)) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "Node.js was not found." }
    $portableNode = $nodeCommand.Source
}
$runtimeDirectory = Join-Path $stageDirectory "runtime"
New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
Copy-Item -LiteralPath $portableNode -Destination (Join-Path $runtimeDirectory "node.exe")

if (Test-Path -LiteralPath (Join-Path $stageDirectory ".env.local")) {
    throw "Refusing to package .env.local"
}
if (-not (Test-Path -LiteralPath (Join-Path $stageDirectory "node_modules\@openai\codex\bin\codex.js"))) {
    throw "Codex runtime is missing from the package."
}

Compress-Archive -LiteralPath $stageDirectory -DestinationPath $archivePath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumPath -Value "$hash  $packageName.zip" -Encoding ASCII
Write-Host "Release package: $archivePath"
Write-Host "SHA256: $hash"
