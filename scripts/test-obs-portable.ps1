param(
  [string]$ObsPath = 'C:\Program Files\obs-studio',
  [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$root = [IO.Path]::GetFullPath($root)
$testRoot = [IO.Path]::GetFullPath((Join-Path $root 'build/obs-test'))
if (!$testRoot.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Test path must be inside the plugin project.'
}
$obsRoot = (Resolve-Path -LiteralPath $ObsPath).Path
$obsExe = Join-Path $obsRoot 'bin/64bit/obs64.exe'
if (!(Test-Path -LiteralPath $obsExe)) { throw 'OBS installation not found.' }
if ($obsRoot.StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose the original OBS installation as copy source.' }
if (!$PrepareOnly -and (Get-Process -Name obs64 -ErrorAction SilentlyContinue)) {
  throw 'Close OBS before testing. This test never stops your OBS process.'
}
$receiptFile = Join-Path $root 'package/last-build.json'
$receipt = $null
if (Test-Path -LiteralPath $receiptFile) {
  $receipt = Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
if ($receipt -and (Test-Path -LiteralPath $receipt.directory)) {
  $packageRoot = [IO.Path]::GetFullPath($receipt.directory)
  if (!$packageRoot.StartsWith((Join-Path $root 'package') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build receipt points outside the package directory.'
  }
} else {
  # A cleaned source tree retains only the final distributable, not an unpacked build.
  $archives = @(Get-ChildItem -LiteralPath (Join-Path $root 'package') -File -Filter '*.zip')
  if ($archives.Count -ne 1) { throw 'Keep exactly one final ZIP in package, or run Build.cmd first.' }
  $unpackRoot = Join-Path $root ('build/test-package-' + [Guid]::NewGuid().ToString('N'))
  Write-Host 'Unpacking the final ZIP for the portable test ...'
  Expand-Archive -LiteralPath $archives[0].FullName -DestinationPath $unpackRoot
  $packages = @(Get-ChildItem -LiteralPath $unpackRoot -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName 'obs-plugins/64bit/telegram-widget.dll')
  })
  if ($packages.Count -ne 1) { throw 'The final ZIP does not contain one complete plugin package.' }
  $packageRoot = $packages[0].FullName
  $receipt = Get-Content -LiteralPath (Join-Path $packageRoot 'BUILD-VERIFICATION.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}
$dll = Join-Path $packageRoot 'obs-plugins/64bit/telegram-widget.dll'
if ((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.dllSha256) {
  throw 'Packaged DLL hash does not match the build receipt.'
}
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
Write-Host "Preparing a separate portable OBS in $testRoot"
Write-Host 'The installed OBS, its scenes and StreamOverlay will not be modified. No downloads.'
foreach ($folder in @('bin', 'data', 'obs-plugins')) {
  Copy-Item -LiteralPath (Join-Path $obsRoot $folder) -Destination $testRoot -Recurse -Force
}
Copy-Item -LiteralPath $dll -Destination (Join-Path $testRoot 'obs-plugins/64bit/telegram-widget.dll') -Force
$dataTarget = Join-Path $testRoot 'data/obs-plugins/telegram-widget'
New-Item -ItemType Directory -Force -Path $dataTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $packageRoot 'data/obs-plugins/telegram-widget') -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $dataTarget -Recurse -Force
}
# Portable mode redirects OBS configuration into this copy. Never copy the user's profile.
Set-Content -LiteralPath (Join-Path $testRoot 'portable_mode.txt') -Value '' -Encoding ASCII
$configRoot = Join-Path $testRoot 'config/obs-studio'
New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
$userConfig = Join-Path $configRoot 'user.ini'
if (!(Test-Path -LiteralPath $userConfig)) {
  Set-Content -LiteralPath $userConfig -Encoding UTF8 -Value @'
[General]
FirstRun=true
ConfirmOnExit=false

[Basic]
ConfigOnNewProfile=false
'@
}
if ($PrepareOnly) { Write-Host 'Portable test copy is prepared. Run Test.cmd to open it.'; exit 0 }
$testExe = Join-Path $testRoot 'bin/64bit/obs64.exe'
Write-Host 'Opening ONLY the portable test copy. No streaming or recording will start.'
$testProcess = Start-Process -FilePath $testExe -WorkingDirectory (Split-Path -Parent $testExe) -ArgumentList @('--portable', '--disable-updater', '--disable-shutdown-check', '--disable-missing-files-check') -PassThru
$startedAt = $testProcess.StartTime.ToUniversalTime()
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$log = $null
do {
  Start-Sleep -Milliseconds 500
  $testProcess.Refresh()
  if ($testProcess.HasExited) { throw "Test OBS exited with code $($testProcess.ExitCode). Check the portable OBS logs." }
  $log = Get-ChildItem -LiteralPath (Join-Path $configRoot 'logs') -Filter '*.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($log -and $log.LastWriteTimeUtc -ge $startedAt.AddSeconds(-1)) {
    $content = Get-Content -LiteralPath $log.FullName -Raw -Encoding UTF8
    if ($content -match '\[Telegram Widget\] Local service and dock are ready') { break }
  }
} while ([DateTime]::UtcNow -lt $deadline)
if (!$content -or $content -notmatch '\[Telegram Widget\] Local service and dock are ready') {
  throw 'OBS is open but the plugin did not report ready within 90 seconds. Close any first-run wizard and send the portable OBS log. The test window was left open.'
}
$report = [ordered]@{
  dllSha256 = $receipt.dllSha256
  obsVersion = (Get-Item -LiteralPath $testExe).VersionInfo.ProductVersion
  nativePluginAndDockStartup = 'passed'
  visualSourceCheck = 'manual-required'
  obsPid = $testProcess.Id
  log = $log.FullName
  checkedAt = [DateTime]::UtcNow.ToString('o')
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'build/obs-startup-test.json') -Encoding UTF8
Write-Host 'PASS: OBS loaded the plugin, started its bundled runtime and created the browser dock.' -ForegroundColor Green
Write-Host 'Next: Docks > Telegram Widget; add the source to the scene; enter a Telegram link; test Show and Hide.'
Write-Host 'Close the portable OBS normally when finished. Its settings stay inside build/obs-test.'
