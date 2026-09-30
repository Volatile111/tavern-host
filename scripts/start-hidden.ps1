# Starts a program in its own hidden console window and prints its PID.
# Its own console is what lets us send it Ctrl+C later (see send-ctrl-c.ps1), and it keeps running if the panel stops.
# Input comes as JSON in $env:PANEL_START so nothing is ever parsed as PowerShell code:
#   { "exe": "...", "args": "<already-quoted argument string>", "cwd": "...", "env": { "NAME": "value" } }
$ErrorActionPreference = 'Stop'

# If the panel itself was started as a background (detached) process, Windows marks it and everything it starts as
# "ignore Ctrl+C", which would stop game servers from saving when asked to shut down. Turn normal Ctrl+C handling
# back on here; the program we start inherits it.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CtrlCHandling {
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}
"@
[CtrlCHandling]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null

$spec = $env:PANEL_START | ConvertFrom-Json
if ($spec.env) {
  foreach ($prop in $spec.env.PSObject.Properties) { Set-Item -Path "env:$($prop.Name)" -Value $prop.Value }
}
$params = @{ FilePath = $spec.exe; WorkingDirectory = $spec.cwd; WindowStyle = 'Hidden'; PassThru = $true }
if ($spec.args) { $params.ArgumentList = $spec.args }
$proc = Start-Process @params
Write-Output $proc.Id
