param([Parameter(Mandatory)][int]$ProcessId)
# Sends Ctrl+C to a process that has its own console, the same as pressing Ctrl+C in its window.
# Game servers like Valheim save their world when they receive it.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ConsoleCtrl {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
}
"@
[ConsoleCtrl]::FreeConsole() | Out-Null
if (-not [ConsoleCtrl]::AttachConsole($ProcessId)) {
  Write-Output "attach-failed $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  exit 2
}
# Ignore the Ctrl+C ourselves, then send it to everything attached to that console (just the target).
[ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
[ConsoleCtrl]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
Start-Sleep -Milliseconds 500
[ConsoleCtrl]::FreeConsole() | Out-Null
Write-Output 'sent'
exit 0
