#Requires -Version 5.1
[CmdletBinding()]
param([string]$ExecutablePath, [string]$ArgumentJson = '[]', [string]$WorkingDirectory)

function Start-IndependentWindowsProcess {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$Path, [string[]]$Arguments=@(), [string]$Directory)
    $ErrorActionPreference='Stop'
    $resolved=[IO.Path]::GetFullPath($Path)
    if(-not (Test-Path -LiteralPath $resolved -PathType Leaf)){throw "Missing executable: $resolved"}
    if(-not $Directory){$Directory=Split-Path -Parent $resolved}
    $Directory=[IO.Path]::GetFullPath($Directory)
    if(-not (Test-Path -LiteralPath $Directory -PathType Container)){throw 'Missing working directory.'}
    # Windows CRT quoting; no shell or PowerShell expression is evaluated.
    $quote={param([string]$value) '"'+[regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
    $command=(& $quote $resolved)+' '+(($Arguments | ForEach-Object {& $quote ([string]$_)}) -join ' ')
    # WMI is a system broker, not a child of the calling Codex process tree.
    # Explicit breakaway also prevents inheriting a kill-on-close Job object.
    $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]16777216}
    $result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=$Directory;ProcessStartupInformation=$startup}
    if($result.ReturnValue -ne 0){throw "Independent start failed (Win32 $($result.ReturnValue)); unsafe child-process fallback is disabled."}
    $created=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$result.ProcessId)
    if(-not $created){throw 'Independent process exited before it could be verified.'}
    $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
    if($created.ParentProcessId -eq $PID){throw 'Independent process unexpectedly belongs to the invoking shell.'}
    if($created.SessionId -ne $current.SessionId){throw 'Independent process is not in the interactive user session.'}
    $owner=Invoke-CimMethod -InputObject $created -MethodName GetOwnerSid
    if($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Independent process owner does not match the current user.'}
    [pscustomobject]@{ProcessId=[int]$created.ProcessId;ParentProcessId=[int]$created.ParentProcessId;SessionId=[int]$created.SessionId;Broker='WMI';SameUser=$true;ExecutablePath=$resolved}
}

if($MyInvocation.InvocationName -ne '.'){
    Start-IndependentWindowsProcess -Path $ExecutablePath -Arguments @($ArgumentJson | ConvertFrom-Json) -Directory $WorkingDirectory | ConvertTo-Json -Compress
}
