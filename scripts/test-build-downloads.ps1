$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-complete.ps1') -FunctionsOnly
$testRoot = Join-Path $logRoot ('download-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$toolsRoot = Join-Path $testRoot 'manual-cache'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
$payload = Join-Path $testRoot 'expected.bin'
Set-Content -LiteralPath $payload -Value 'abcdef' -NoNewline -Encoding ASCII
$sha = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash
$script:MockCalls = [Collections.Generic.List[object]]::new()
$script:MockFailures = 1
$script:MockExitCode = 28
$script:MockCorrupt = $false
$script:CurlPath = 'mock-curl'

function Invoke-BuildStep {
  param($Label,$File,$Arguments,$TimeoutSec,$WorkingDirectory,$ProgressFile)
  $script:MockCalls.Add(@{ Arguments=$Arguments; Timeout=$TimeoutSec })
  $index = [array]::IndexOf([string[]]$Arguments, '--output')
  $target = $Arguments[$index + 1]
  if ($script:MockFailures -gt 0) {
    $script:MockFailures--
    Set-Content -LiteralPath $target -Value 'abc' -NoNewline -Encoding ASCII
    $error = [InvalidOperationException]::new('Simulated curl failure')
    $error.Data['ExitCode'] = $script:MockExitCode
    throw $error
  }
  $value = if ($script:MockCorrupt) { 'bad checksum' } else { 'abcdef' }
  Set-Content -LiteralPath $target -Value $value -NoNewline -Encoding ASCII
}
function Assert-True($Condition,[string]$Message) { if (!$Condition) { throw $Message } }

$destination = Join-Path $testRoot 'retry.bin'
Get-Download 'https://example.invalid/archive' $destination $sha -TimeoutSec 60 -RetryDelaySec 0
Assert-True ($script:MockCalls.Count -eq 2) 'Temporary failure was not retried'
Assert-True ($script:MockCalls[0].Arguments -contains '--ipv4') 'IPv4 option missing'
Assert-True ($script:MockCalls[0].Arguments -contains '--http1.1') 'HTTP/1.1 option missing'
Assert-True ($script:MockCalls[1].Arguments -contains '--continue-at') 'Partial archive was not resumed'
Assert-True ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $sha) 'Verified download not promoted'
$before = $script:MockCalls.Count
Get-Download 'https://example.invalid/archive' $destination $sha -TimeoutSec 60 -RetryDelaySec 0
Assert-True ($script:MockCalls.Count -eq $before) 'Valid cache should not use network'

$destination = Join-Path $testRoot 'recovered.bin'
Copy-Item -LiteralPath $payload -Destination ($destination + '.part')
Get-Download 'https://example.invalid/archive' $destination $sha -TimeoutSec 60 -RetryDelaySec 0
Assert-True ($script:MockCalls.Count -eq $before) 'Complete partial file should be recovered without network'

$destination = Join-Path $testRoot 'imported.bin'
Copy-Item -LiteralPath $payload -Destination (Join-Path $toolsRoot 'imported.bin')
Get-Download 'https://example.invalid/archive' $destination $sha -TimeoutSec 60 -RetryDelaySec 0
Assert-True ($script:MockCalls.Count -eq $before) 'A manually downloaded valid archive should not use network'
Assert-True ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $sha) 'Manual cache import did not preserve bytes'

$script:MockCalls.Clear(); $script:MockFailures = 10
$failed = $false
try { Get-Download 'https://example.invalid/archive' (Join-Path $testRoot 'bounded.bin') $sha -TimeoutSec 60 -RetryDelaySec 0 }
catch { $failed = $true }
Assert-True ($failed -and $script:MockCalls.Count -eq 3) 'Retries must stop after three attempts'

$script:MockCalls.Clear(); $script:MockFailures = 1; $script:MockExitCode = 22
$failed = $false
try { Get-Download 'https://example.invalid/archive' (Join-Path $testRoot 'permanent.bin') $sha -TimeoutSec 60 -RetryDelaySec 0 }
catch { $failed = $true }
Assert-True ($failed -and $script:MockCalls.Count -eq 1) 'Permanent HTTP failure should not be retried blindly'

$script:MockCalls.Clear(); $script:MockFailures = 1; $script:MockExitCode = 33
$destination = Join-Path $testRoot 'fresh.bin'
Set-Content -LiteralPath ($destination + '.part') -Value 'abc' -NoNewline -Encoding ASCII
Get-Download 'https://example.invalid/archive' $destination $sha -TimeoutSec 60 -RetryDelaySec 0
Assert-True ($script:MockCalls[0].Arguments -contains '--continue-at') 'Expected first resume attempt'
Assert-True ($script:MockCalls[1].Arguments -notcontains '--continue-at') 'Unsupported range should fall back to fresh download'

$script:MockCalls.Clear(); $script:MockFailures = 0; $script:MockCorrupt = $true
$destination = Join-Path $testRoot 'corrupt.bin'
$failed = $false
try { Get-Download 'https://example.invalid/archive' $destination $sha -TimeoutSec 60 -RetryDelaySec 0 }
catch { $failed = $_.Exception.Message -match 'SHA256 mismatch' }
Assert-True ($failed -and !(Test-Path -LiteralPath $destination)) 'Corrupt file must never be promoted'
Write-Host 'Download checks passed: retries, IPv4, resume, cache recovery, limits, range fallback and SHA256 enforcement.' -ForegroundColor Green
