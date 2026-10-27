; Inno Setup script for My Tube. Build it with build-installer.bat (it passes /DAppVersion from the VERSION file).
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "My Tube"
#define RepoUrl "https://github.com/mohameddddt/mytube-invidious"

[Setup]
#ifdef TestBuild
; throwaway build for testing the installer: own identity, and it ignores a running app
AppId={{6E1C4D0A-0000-4A59-9D52-3F1B8C2A7E64}
#else
AppId={{6E1C4D0A-7B3F-4A59-9D52-3F1B8C2A7E64}
; the launcher holds this mutex while it runs, so setup never replaces a running app
AppMutex=Local\MyTubeLauncher
#endif
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=mohameddddt
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; installs for the current user only: no administrator prompt, lands in %LOCALAPPDATA%\Programs
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=MyTube-Setup-{#AppVersion}
SetupIconFile=..\assets\mytube.ico
UninstallDisplayIcon={app}\MyTube.exe
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
VersionInfoVersion={#AppVersion}
VersionInfoCompany=mohameddddt
VersionInfoDescription={#AppName} setup
VersionInfoProductName={#AppName}
InfoAfterFile=after-install.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "..\build\exe\MyTube.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\assets\mytube-signing.cer"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs
Source: "..\deploy\*"; DestDir: "{app}\deploy"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\MyTube.exe"; Comment: "Personal YouTube interface"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\MyTube.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\MyTube.exe"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
// Your subscriptions, history and settings live outside the program folder, so an uninstall keeps them
// unless you say otherwise. Downloaded videos and music are never touched.
procedure CurrentUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\MyTube');
    if DirExists(DataDir) then
      if MsgBox('Also delete your My Tube data (subscriptions, history, settings and the app window profile)?' + #13#10#13#10 +
                DataDir + #13#10#13#10 + 'Your downloaded videos and music are never deleted.',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
