# Saves the full source of the current version as versions\tavern-host-<version>-source.zip before a build,
# and copies it to the A: drive (a second machine) when that drive is available. Run by `npm run dist`.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$versionsDir = Join-Path $root 'versions'
New-Item -ItemType Directory -Force $versionsDir | Out-Null

$zip = Join-Path $versionsDir "tavern-host-$version-source.zip"
if (Test-Path $zip) {
  # Never overwrite a saved version; keep the earlier snapshot and add a timestamped one.
  $zip = Join-Path $versionsDir ("tavern-host-$version-source-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
}

$items = 'src', 'public', 'scripts', 'desktop', 'tools', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', '.gitignore', 'Start Panel.bat' |
  ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }
Compress-Archive -Path $items -DestinationPath $zip
Write-Output "Saved source snapshot: $zip"

$backup = 'A:\Tavern Host\source'
if (Test-Path 'A:\') {
  New-Item -ItemType Directory -Force $backup | Out-Null
  Copy-Item $zip $backup
  Write-Output "Copied to $backup"
}
