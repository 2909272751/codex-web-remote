param([string]$Node, [string]$Fixture, [string]$Helper, [string]$StateFile)
$ErrorActionPreference='Stop'
. $Helper
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FixtureJob {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int type,byte[] data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
}
'@
$job=[FixtureJob]::CreateJobObject([IntPtr]::Zero,$null)
$limits=New-Object byte[] 144
[BitConverter]::GetBytes([uint32]0x2800).CopyTo($limits,16)
if(-not [FixtureJob]::SetInformationJobObject($job,9,$limits,144)){throw 'Could not configure test Job'}
if(-not [FixtureJob]::AssignProcessToJobObject($job,[Diagnostics.Process]::GetCurrentProcess().Handle)){throw 'Could not enter test Job'}
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$Node
$info.Arguments='"'+$Fixture+'" --leaf "'+$StateFile+'.normal"'
$info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.WindowStyle='Hidden'
$normal=[Diagnostics.Process]::Start($info)
$outside=Start-IndependentWindowsProcess -Path $Node -Arguments @($Fixture,'--leaf',($StateFile+'.independent')) -Directory (Split-Path -Parent $Fixture)
[IO.File]::WriteAllText($StateFile,([pscustomobject]@{hostPid=$PID;normalPid=$normal.Id;independentPid=$outside.ProcessId;broker=$outside.Broker;sessionId=$outside.SessionId} | ConvertTo-Json -Compress))
while($true){Start-Sleep -Seconds 1}
