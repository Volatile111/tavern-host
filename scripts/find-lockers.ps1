# Lists programs that are keeping a file or folder busy (so it can't be deleted or moved), one per line:
#   <program>|<detail>
# Finds File Explorer windows open inside it, programs started from it (or with it on their command line), and, via the
# Windows Restart Manager, programs holding files in it open. Target path comes in $env:PANEL_TARGET.
$ErrorActionPreference = 'SilentlyContinue'
$target = [IO.Path]::GetFullPath($env:PANEL_TARGET).TrimEnd('\')
$found = New-Object System.Collections.Generic.List[string]
function Inside($p) { if (-not $p) { return $false }; $p = $p.TrimEnd('\'); return $p -eq $target -or $p.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase) }

# File Explorer windows showing the folder (or a folder inside it)
foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
  try {
    $loc = ([Uri]$w.LocationURL).LocalPath
    if (Inside $loc) { $found.Add("File Explorer|window open at $loc") }
  } catch {}
}

# Programs running from the folder, or opened with a file in it
foreach ($p in Get-CimInstance Win32_Process) {
  if ($p.ProcessId -eq $PID) { continue }
  if (Inside $p.ExecutablePath) { $found.Add("$($p.Name)|running from this folder, PID $($p.ProcessId)"); continue }
  if ($p.CommandLine -and $p.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $p.Name -notin @('powershell.exe', 'pwsh.exe')) {
    $found.Add("$($p.Name)|has something from this folder open, PID $($p.ProcessId)")
  }
}

# Programs holding files open (Restart Manager)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RmLockers {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvc, string[] svc);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static List<string> Find(string[] files) {
    var result = new List<string>();
    uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return result;
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) return result;
      uint needed = 0, count = 0, reasons = 0;
      int rc = RmGetList(h, out needed, ref count, null, ref reasons);
      if (rc == 234 && needed > 0) {
        var info = new RM_PROCESS_INFO[needed]; count = needed;
        if (RmGetList(h, out needed, ref count, info, ref reasons) == 0)
          for (int i = 0; i < count; i++) result.Add(info[i].strAppName + "|has files in it open, PID " + info[i].Process.dwProcessId);
      }
    } finally { RmEndSession(h); }
    return result;
  }
}
'@
$files = @(if (Test-Path -LiteralPath $target -PathType Leaf) { $target } else { Get-ChildItem -LiteralPath $target -Recurse -File -Force | Select-Object -First 3000 -ExpandProperty FullName })
if ($files.Count) { foreach ($l in [RmLockers]::Find($files)) { $found.Add($l) } }

$found | Select-Object -Unique
