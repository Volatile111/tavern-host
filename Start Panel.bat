@echo off
rem Runs the panel in the background and opens it. Game servers keep running even if the panel is closed.
cd /d "%~dp0"
powershell -NoProfile -WindowStyle Hidden -Command "if (-not (Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction SilentlyContinue)) { Start-Process node -ArgumentList 'src/main.ts' -WorkingDirectory '%~dp0.' -WindowStyle Hidden -RedirectStandardOutput '%~dp0data\panel.log' -RedirectStandardError '%~dp0data\panel.err.log'; Start-Sleep 2 }; Start-Process 'http://127.0.0.1:8190'"
