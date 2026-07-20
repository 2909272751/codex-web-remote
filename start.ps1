param(
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 18888,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $ProjectDirectory ".env.local"

if (-not (Test-Path -LiteralPath $envFile)) {
    if ($NonInteractive) { throw ".env.local does not exist. Run .\setup.ps1 first." }
    Write-Host "First run: set a Web access password (at least 8 characters)."
    $secure = Read-Host "Web password" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($plain.Length -lt 8) { throw "Password must contain at least 8 characters." }
    @(
        "CODEX_WEB_PASSWORD=$plain"
        "CODEX_WEB_HOST=$HostAddress"
        "CODEX_WEB_PORT=$Port"
        "CODEX_WEB_SECURE_COOKIE=0"
        "CODEX_WEB_SESSION_HOURS=24"
    ) | Set-Content -LiteralPath $envFile -Encoding UTF8
    $plain = $null
    Write-Host "Saved configuration to .env.local (ignored by Git)."
}

Set-Location -LiteralPath $ProjectDirectory
$portableNode = Join-Path $ProjectDirectory "runtime\node.exe"
$codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $portableNode) { $node = $portableNode }
elseif (Test-Path -LiteralPath $codexNode) { $node = $codexNode }
else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "Node.js was not found. Use the portable Release package or install Node.js 22+." }
    $node = $nodeCommand.Source
}
& $node server.mjs
