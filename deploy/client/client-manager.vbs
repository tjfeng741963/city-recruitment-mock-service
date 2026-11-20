Option Explicit
Dim shell, fso, root, python, script
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
python = "C:\PROGRA~1\Python311\pythonw.exe"
script = fso.BuildPath(root, "client_manager.py")
If Not fso.FileExists(python) Or Not fso.FileExists(script) Then
    MsgBox "Client manager or Python 3.11 is missing. Please check installation.", 16, "City Recruitment"
    WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run """" & python & """ """ & script & """", 0, False
