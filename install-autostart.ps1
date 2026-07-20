$ErrorActionPreference = "Stop"
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $ProjectDirectory ".env.local"
$launcher = Join-Path $ProjectDirectory "start-hidden.vbs"
$taskName = "Codex Web Remote"

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Run .\start.ps1 first to set a password and verify the service."
}
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Hidden launcher was not found: $launcher"
}

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"' + $launcher + '"') -WorkingDirectory $ProjectDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Start the private Codex Web Remote gateway at sign-in." -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started scheduled task: $taskName"
$portLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^CODEX_WEB_PORT=' } | Select-Object -First 1
$configuredPort = if ($portLine) { ($portLine -split '=', 2)[1] } else { "18888" }
Write-Host "Local URL: http://127.0.0.1:$configuredPort"
