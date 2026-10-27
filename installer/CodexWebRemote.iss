#ifndef StageDir
  #error StageDir must be provided by build-installer.ps1
#endif
#ifndef MyAppVersion
  #define MyAppVersion "2.1.0"
#endif
#ifndef ChineseLanguageFile
  #error ChineseLanguageFile must be provided by build-installer.ps1
#endif

[Setup]
AppId={{6A2F8F13-35E3-45E2-B590-E97A4E0F2F91}
AppName=Codex Web Remote
AppVersion={#MyAppVersion}
AppPublisher=2909272751
AppPublisherURL=https://github.com/2909272751/codex-web-remote
AppSupportURL=https://github.com/2909272751/codex-web-remote/issues
; DefaultDirName is only a fallback: an existing installation always wins.
; See GetPreferredDir() in [Code] — an installation whose uninstall entry is
; missing (e.g. restored from a backup) is still found through the autostart
; entry, so an upgrade can never silently create a second instance.
DefaultDirName={code:GetPreferredDir}
UsePreviousAppDir=yes
DefaultGroupName=Codex Web Remote
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
WizardSizePercent=110
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
OutputBaseFilename=CodexWebRemote-Setup-{#MyAppVersion}-win-x64
UninstallDisplayName=Codex Web Remote
UninstallDisplayIcon={app}\CodexWebRemote.exe
CloseApplications=yes
CloseApplicationsFilter=CodexWebRemote.exe
RestartApplications=no
SetupLogging=yes
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductName=Codex Web Remote
VersionInfoDescription=Codex Web Remote Windows Installer

[Languages]
Name: "chinesesimp"; MessagesFile: "{#ChineseLanguageFile}"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他选项："; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Codex Web Remote"; Filename: "{app}\CodexWebRemote.exe"
Name: "{group}\卸载 Codex Web Remote"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Codex Web Remote"; Filename: "{app}\CodexWebRemote.exe"; Tasks: desktopicon

[Run]
Filename: "{cmd}"; Parameters: "/C schtasks.exe /End /TN ""Codex Web Remote"" >nul 2>&1 & schtasks.exe /Delete /TN ""Codex Web Remote"" /F >nul 2>&1 & exit /b 0"; Flags: runhidden waituntilterminated; StatusMsg: "正在迁移旧版后台任务…"; Check: NotQaMode
; skipifsilent is deliberate: a silent install must not spawn a tray process,
; otherwise scripted installs (Start-Process -Wait) never return and the caller
; loses control over when the gateway starts. Use scripts/deploy-sync.ps1 or
; start CodexWebRemote.exe --background afterwards.
Filename: "{app}\CodexWebRemote.exe"; Description: "启动 Codex Web Remote"; Flags: nowait postinstall skipifsilent; Check: NotQaMode

[UninstallRun]
Filename: "{app}\CodexWebRemote.exe"; Parameters: "--shutdown"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "ShutdownLauncher"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunValueName = 'Codex Web Remote';

function NotQaMode: Boolean;
begin
  Result := ExpandConstant('{param:QA|0}') <> '1';
end;

// Returns the install directory of an existing instance that is present on
// disk. The autostart entry is written by the application itself and points at
// the launcher that is actually in use, which makes it the most reliable
// on-disk marker: it survives a missing/corrupt uninstall registry entry.
function DetectExistingDir: String;
var
  Value, Dir: String;
  ClosingQuote: Integer;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, RunKey, RunValueName, Value) then Exit;
  Value := Trim(Value);
  if (Length(Value) < 2) or (Value[1] <> '"') then Exit;
  Delete(Value, 1, 1);
  ClosingQuote := Pos('"', Value);
  if ClosingQuote < 2 then Exit;
  Dir := ExtractFileDir(Copy(Value, 1, ClosingQuote - 1));
  if FileExists(AddBackslash(Dir) + 'CodexWebRemote.exe') then Result := Dir;
end;

function GetPreferredDir(Param: String): String;
var
  Existing: String;
begin
  Existing := DetectExistingDir();
  if Existing <> '' then
    Result := Existing
  else
    Result := ExpandConstant('{localappdata}\Programs\CodexWebRemote');
end;

// Interactive safety net: never let the wizard create a second instance
// without saying so out loud.
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Existing, Chosen: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then Exit;
  Existing := DetectExistingDir();
  if Existing = '' then Exit;
  Chosen := RemoveBackslashUnlessRoot(WizardDirValue);
  if CompareText(Chosen, RemoveBackslashUnlessRoot(Existing)) = 0 then Exit;
  Result := MsgBox('检测到已安装的 Codex Web Remote：' + #13#10 + Existing + #13#10#13#10 +
    '继续安装到：' + #13#10 + Chosen + #13#10#13#10 +
    '会创建第二份实例（两个托盘图标、两个卸载项，并且端口会冲突）。' + #13#10 +
    '如果只是想升级，请改回上面的目录。' + #13#10#13#10 +
    '确定要继续吗？', mbConfirmation, MB_YESNO) = IDYES;
end;
