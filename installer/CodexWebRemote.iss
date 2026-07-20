#ifndef StageDir
  #error StageDir must be provided by build-installer.ps1
#endif
#ifndef MyAppVersion
  #define MyAppVersion "1.2.0"
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
DefaultDirName={localappdata}\Programs\CodexWebRemote
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
Filename: "{app}\CodexWebRemote.exe"; Description: "启动 Codex Web Remote"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\CodexWebRemote.exe"; Parameters: "--shutdown"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "ShutdownLauncher"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function NotQaMode: Boolean;
begin
  Result := ExpandConstant('{param:QA|0}') <> '1';
end;
