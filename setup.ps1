param(
    [string]$HostAddress = "127.0.0.1",
    [ValidateRange(1, 65535)][int]$Port = 18888,
    [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $ProjectDirectory ".env.local"
$portableNode = Join-Path $ProjectDirectory "runtime\node.exe"
$codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

Write-Host "Codex Web Remote setup" -ForegroundColor Cyan

$codexPackage = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue
if (-not $codexPackage) {
    Write-Warning "Codex Windows App was not detected. Install it and sign in before using existing App tasks."
}

$edgePaths = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
)
if (-not ($edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)) {
    Write-Warning "Microsoft Edge was not detected. Web browsing tools will be unavailable until Edge is installed."
}

if (Test-Path -LiteralPath $portableNode) { $node = $portableNode }
elseif (Test-Path -LiteralPath $codexNode) { $node = $codexNode }
else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "Node.js was not found. Download the portable Windows Release package." }
    $node = $nodeCommand.Source
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectDirectory "node_modules\@openai\codex\bin\codex.js"))) {
    throw "Runtime dependencies are missing. Download the portable Windows Release package instead of GitHub source code."
}

if (-not (Test-Path -LiteralPath $envFile)) {
    do {
        $secure = Read-Host "Set Web password (at least 8 characters)" -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($plain.Length -lt 8) { Write-Warning "Password must contain at least 8 characters." }
    } while ($plain.Length -lt 8)

    @(
        "CODEX_WEB_PASSWORD=$plain"
        "CODEX_WEB_HOST=$HostAddress"
        "CODEX_WEB_PORT=$Port"
        "CODEX_WEB_SECURE_COOKIE=0"
        "CODEX_WEB_SESSION_HOURS=24"
    ) | Set-Content -LiteralPath $envFile -Encoding UTF8
    $plain = $null
    Write-Host "Created private configuration: .env.local"
} else {
    Write-Host "Keeping existing .env.local configuration."
}

& $node --check (Join-Path $ProjectDirectory "server.mjs")
if ($LASTEXITCODE -ne 0) { throw "Server validation failed." }

if ($NoAutostart) {
    Write-Host "Setup completed. Start with: .\start.ps1"
} else {
    & (Join-Path $ProjectDirectory "install-autostart.ps1")
    Write-Host "Setup completed. Open http://127.0.0.1:$Port"
}
