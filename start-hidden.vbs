Option Explicit

Dim shell, fso, projectDir, nodePath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = projectDir & "\runtime\node.exe"

If Not fso.FileExists(nodePath) Then
    nodePath = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
End If

If Not fso.FileExists(nodePath) Then
    nodePath = "node.exe"
End If

shell.CurrentDirectory = projectDir
command = Chr(34) & nodePath & Chr(34) & " server.mjs"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
