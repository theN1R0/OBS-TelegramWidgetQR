param([Parameter(Mandatory=$true)][string]$ObsPath)
$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$resolvedObs = (Resolve-Path -LiteralPath $ObsPath).Path
if (!(Test-Path -LiteralPath (Join-Path $resolvedObs 'bin/64bit/obs64.exe'))) { throw 'Choose the OBS installation directory containing bin/64bit/obs64.exe' }
if (Get-Process -Name obs64 -ErrorAction SilentlyContinue) { throw 'Close OBS before installing.' }
$binary = Join-Path $packageRoot 'obs-plugins/64bit/telegram-widget.dll'
$data = Join-Path $packageRoot 'data/obs-plugins/telegram-widget'
if (!(Test-Path -LiteralPath $binary) -or !(Test-Path -LiteralPath (Join-Path $data 'runtime/node.exe')) -or !(Test-Path -LiteralPath (Join-Path $data 'dist/index.html')) -or !(Test-Path -LiteralPath (Join-Path $data 'node_modules'))) { throw 'Incomplete package. Build package:windows first.' }
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedObs 'obs-plugins/64bit'),(Join-Path $resolvedObs 'data/obs-plugins/telegram-widget') | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $resolvedObs 'obs-plugins/64bit/telegram-widget.dll') -Force
Get-ChildItem -LiteralPath $data | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $resolvedObs 'data/obs-plugins/telegram-widget') -Recurse -Force }
Write-Host 'Installed. Start OBS and enable Docks > Telegram Widget.'
