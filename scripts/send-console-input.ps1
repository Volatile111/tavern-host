# Types a line into another process's console (for game servers that only read commands from a real console window,
# such as Terraria / tModLoader: piped input is ignored). Attaches to the target's console and writes the text as key
# presses followed by Enter. Usage: send-console-input.ps1 -ProcessId 1234 -Text "say hello"
# The key records are built in C#: PowerShell can't set fields of a struct nested in another struct (it edits a copy).
param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][string]$Text)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TavernConsoleInput {
  [StructLayout(LayoutKind.Explicit)]
  struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public ushort UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buffer, uint length, out uint written);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  /// <summary>Returns "sent" or what went wrong.</summary>
  public static string Send(uint pid, string text) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach-failed " + Marshal.GetLastWin32Error();
    try {
      // CONIN$ = the attached console's input buffer (GENERIC_READ | GENERIC_WRITE, shared read/write, OPEN_EXISTING).
      IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == new IntPtr(-1)) return "open-failed " + Marshal.GetLastWin32Error();
      string line = text + "\r";
      var records = new INPUT_RECORD[line.Length * 2];
      for (int i = 0; i < line.Length; i++) {
        for (int d = 0; d < 2; d++) {
          var r = new INPUT_RECORD();
          r.EventType = 1; // KEY_EVENT
          r.bKeyDown = d == 0 ? 1 : 0;
          r.wRepeatCount = 1;
          r.UnicodeChar = line[i];
          if (line[i] == '\r') r.wVirtualKeyCode = 0x0D; // Enter
          records[i * 2 + d] = r;
        }
      }
      uint written;
      bool ok = WriteConsoleInputW(h, records, (uint)records.Length, out written);
      int err = Marshal.GetLastWin32Error();
      CloseHandle(h);
      return ok ? "sent" : "write-failed " + err;
    } finally {
      FreeConsole();
    }
  }
}
'@
$result = [TavernConsoleInput]::Send([uint32]$ProcessId, $Text)
Write-Output $result
if ($result -ne 'sent') { exit 2 }
exit 0
