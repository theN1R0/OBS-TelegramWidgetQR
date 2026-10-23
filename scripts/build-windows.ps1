param(
  [Parameter(Mandatory=$true)][string]$ObsSdk,
  [Parameter(Mandatory=$true)][string]$QtSdk,
  [Parameter(Mandatory=$true)][string]$BrowserPanelInclude,
  [string]$Generator = 'Visual Studio 17 2022',
  [string]$NodeRuntime = (Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
foreach ($directory in @($ObsSdk, $QtSdk, $BrowserPanelInclude)) {
  if (!(Test-Path -LiteralPath $directory -PathType Container)) { throw "Missing SDK directory: $directory" }
}
if (!(Test-Path -LiteralPath (Join-Path $BrowserPanelInclude 'browser-panel.hpp'))) { throw 'browser-panel.hpp not found' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
& cmake -S . -B build/native -G $Generator -A x64 "-DCMAKE_PREFIX_PATH=$ObsSdk;$QtSdk" "-DOBS_BROWSER_INCLUDE_DIR=$BrowserPanelInclude"
if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed' }
& cmake --build build/native --config Release
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
& npm.cmd run package:windows -- --dll build/native/Release/telegram-widget.dll --runtime $NodeRuntime
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
