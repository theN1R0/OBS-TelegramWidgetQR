param([switch]$RealObsArchive)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-complete.ps1') -FunctionsOnly
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$fixtureRoot = Join-Path $logRoot ('archive-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null

function New-TestArchive([string]$File, [string]$LinkName) {
  $stream = [IO.File]::Open($File, 'CreateNew', 'Write')
  $zip = [IO.Compression.ZipArchive]::new($stream, 'Create')
  try {
    $entry = $zip.CreateEntry('obs-source/CMakeLists.txt')
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('project(test)') } finally { $writer.Dispose() }
    $entry = $zip.CreateEntry($LinkName)
    $entry.ExternalAttributes = -1610612736 # Unix S_IFLNK in the upper 16 bits.
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('./.build.zsh') } finally { $writer.Dispose() }
  } finally { $zip.Dispose(); $stream.Dispose() }
}

$archive = Join-Path $fixtureRoot 'source.zip'
New-TestArchive $archive 'obs-source/.github/scripts/build-macos'
$originalHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
$rejected = $false
try { Expand-VerifiedZip $archive (Join-Path $fixtureRoot 'strict') 'obs-source/CMakeLists.txt' }
catch { if ($_.Exception.Message -match 'Unsafe archive entry') { $rejected = $true } else { throw } }
if (!$rejected) { throw 'Strict extraction accepted a symlink' }
$destination = Join-Path $fixtureRoot 'windows'
Expand-VerifiedZip $archive $destination 'obs-source/CMakeLists.txt' -SkipUnixSymlinks
if (!(Test-Path -LiteralPath (Join-Path $destination 'obs-source/CMakeLists.txt'))) { throw 'Normal source file not extracted' }
if (Test-Path -LiteralPath (Join-Path $destination 'obs-source/.github/scripts/build-macos')) { throw 'Symlink should not be extracted' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $originalHash) { throw 'Original archive was modified' }
foreach ($link in @('../escape.txt','obs-source/include/malicious.h')) {
  $file = Join-Path $fixtureRoot (([guid]::NewGuid().ToString('N')) + '.zip')
  New-TestArchive $file $link
  $rejected = $false
  try { Expand-VerifiedZip $file (Join-Path $fixtureRoot ([guid]::NewGuid().ToString('N'))) 'obs-source/CMakeLists.txt' -SkipUnixSymlinks }
  catch { if ($_.Exception.Message -match 'Unsafe archive entry') { $rejected = $true } else { throw } }
  if (!$rejected) { throw "Unsafe link accepted: $link" }
}
Write-Host 'Archive checks passed: strict mode, Unix-only filtering, original hash, path traversal and unknown symlinks.' -ForegroundColor Green

if ($RealObsArchive) {
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-sdk.json') -Raw | ConvertFrom-Json
  $source = $manifest.archives | Where-Object name -eq 'obs-source'
  $download = Join-Path $toolsRoot $source.file
  if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $source.sha256) { throw 'OBS archive checksum mismatch' }
  $script:CMakePath = Join-Path $toolsRoot "cmake/cmake-$($manifest.cmakeVersion)-windows-x86_64/bin/cmake.exe"
  Expand-VerifiedZip $download (Join-Path $toolsRoot 'obs-source') "obs-studio-$($manifest.obsVersion)/CMakeLists.txt" -SkipUnixSymlinks
  Write-Host 'Real OBS source archive: checksum and Windows extraction passed.' -ForegroundColor Green
}
