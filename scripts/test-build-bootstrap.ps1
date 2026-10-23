param([switch]$ConfirmationOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-complete.ps1') -FunctionsOnly
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw "$Message -- expected [$Expected], received [$Actual]" }
}

foreach ($answer in @('YES','yes','Yes','yEs',' yes ')) {
  Assert-Equal (Test-InstallConfirmation $answer) $true 'Affirmative confirmation'
}
foreach ($answer in @('','NO','y','yes please',$null)) {
  Assert-Equal (Test-InstallConfirmation $answer) $false 'Installation must require explicit yes'
}
if ($ConfirmationOnly) { Write-Host 'Installation confirmation: 10 checks passed.'; return }

$tokens = $null; $parseErrors = $null
foreach ($file in @('build-complete.ps1','build-windows.ps1','install-windows.ps1')) {
  [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
Assert-Equal (ConvertTo-NativeArgument '') '""' 'Empty native argument'
Assert-Equal (ConvertTo-NativeArgument 'C:\some folder\') '"C:\some folder\\"' 'Trailing slash quoting'
Assert-Equal (ConvertTo-NativeArgument 'a"b') '"a\"b"' 'Embedded quote escaping'
$escaped = $false
try { Assert-ProjectPath ([IO.Path]::GetPathRoot($projectRoot)) | Out-Null } catch { $escaped = $true }
if (!$escaped) { throw 'Outside-project path was accepted' }
$sum = 'a' * 64
Assert-Equal (Get-Checksum "$sum  file.zip`r`n" 'file.zip') $sum 'Checksum parser'
Assert-Equal (Get-Checksum "$sum *file.zip`n" 'file.zip') $sum 'Binary checksum parser'

$shell = Join-Path $PSHOME 'powershell.exe'
if (!(Test-Path -LiteralPath $shell)) { $shell = (Get-Process -Id $PID).Path }
$probe = Join-Path $PSScriptRoot 'bootstrap-argument-probe.ps1'
$outFile = Join-Path $logRoot 'bootstrap-probe.json'
Invoke-BuildStep -Label 'Bootstrap native argument test' -File $shell -TimeoutSec 15 -Arguments @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',$probe,'-Destination',$outFile,
  '-Text','C:\a folder\','-Second','-DCMAKE_PREFIX_PATH=a;b c'
)
$result = Get-Content -LiteralPath $outFile -Raw | ConvertFrom-Json
Assert-Equal $result.text 'C:\a folder\' 'Argument round trip'
Assert-Equal $result.second '-DCMAKE_PREFIX_PATH=a;b c' 'Semicolon argument round trip'
$failed = $false
try { Invoke-BuildStep -Label 'Bootstrap failure detection test' -File $shell -Arguments @('-NoProfile','-Command','exit 7') -TimeoutSec 15 }
catch { if ($_.Exception.Message -match 'exit 7') { $failed = $true } else { throw } }
if (!$failed) { throw 'Child failure was not detected' }
$npmProbe = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmProbe) {
  Invoke-BuildStep -Label 'Bootstrap CMD launch test' -File $npmProbe.Source -Arguments @('--version') -TimeoutSec 15
}
$timedOut = $false
try { Invoke-BuildStep -Label 'Bootstrap timeout test' -File $shell -Arguments @('-NoProfile','-Command','Start-Sleep -Seconds 3') -TimeoutSec 1 }
catch { if ($_.Exception.Message -match 'timed out') { $timedOut = $true } else { throw } }
if (!$timedOut) { throw 'Timeout was not enforced' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$unsafeZip = Join-Path $logRoot ('unsafe-' + [guid]::NewGuid().ToString('N') + '.zip')
$stream = [IO.File]::Open($unsafeZip, 'CreateNew', 'Write')
$zip = [IO.Compression.ZipArchive]::new($stream, 'Create')
try { $null = $zip.CreateEntry('../outside.txt') } finally { $zip.Dispose(); $stream.Dispose() }
$rejected = $false
try { Expand-VerifiedZip $unsafeZip (Join-Path $logRoot 'zip-safety-check') 'expected.txt' }
catch { if ($_.Exception.Message -match 'Unsafe archive entry') { $rejected = $true } else { throw } }
if (!$rejected) { throw 'Zip traversal was not rejected' }
Write-Host 'Bootstrap syntax, quoting, logs, paths, child exits, CMD launch, timeout and zip safety checks passed.' -ForegroundColor Green
