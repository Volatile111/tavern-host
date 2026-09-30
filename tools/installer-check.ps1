# Runs at the start of the Tavern Host installer (embedded in desktop/installer.nsh as -EncodedCommand; after changing
# this file run: node tools/make-installer-nsh.mjs).
# - Game servers started by versions before the separate runner run "runner.js" under Tavern Host.exe itself; that file
#   can't be replaced while they run, and closing them would stop the servers. Exit 2 so the installer can say so.
# - Otherwise close the panel window and background service (current and pre-rename names). Runners from newer
#   versions are "Tavern Host Runner.exe" in the data folder and are left alone, so game servers keep running.
$names = @('Tavern Host.exe', 'Game Server Panel.exe')
$procs = @(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name })
if ($procs | Where-Object { $_.CommandLine -like '*runner.js*' }) { exit 2 }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
exit 0
