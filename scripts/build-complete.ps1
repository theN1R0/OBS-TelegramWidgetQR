[CmdletBinding()]
param(
  [switch]$InstallBuildTools,
  [switch]$FunctionsOnly,
  [ValidateRange(60,7200)][int]$DownloadTimeoutSec = 900,
  [string]$ObsPath = 'C:\Program Files\obs-studio'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$buildRoot = Join-Path $projectRoot 'build'
$toolsRoot = Join-Path $buildRoot 'bootstrap'
$logRoot = Join-Path $buildRoot 'logs'
$script:CurlPath = $null
$script:CMakePath = $null
$script:StepNumber = 0

function Assert-ProjectPath([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  $prefix = $projectRoot.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (!$absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside the project: $absolute"
  }
  return $absolute
}

function ConvertTo-NativeArgument([AllowEmptyString()][string]$Value) {
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Write-LogLines($Reader, [string]$Prefix = '') {
  if ($null -eq $Reader) { return }
  while (!$Reader.EndOfStream) {
    $line = $Reader.ReadLine()
    if ($null -ne $line) { Write-Host ($Prefix + $line) }
  }
}

function Invoke-BuildStep {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][string]$File,
    [string[]]$Arguments = @(),
    [int]$TimeoutSec = 1800,
    [string]$WorkingDirectory = $projectRoot,
    [string]$ProgressFile = ''
  )
  $script:StepNumber++
  Write-Host "`n[$script:StepNumber] $Label" -ForegroundColor Cyan
  $stem = '{0:D2}-{1}' -f $script:StepNumber, ($Label -replace '[^a-zA-Z0-9_-]', '-')
  $stdout = Assert-ProjectPath (Join-Path $logRoot "$stem.out.log")
  $stderr = Assert-ProjectPath (Join-Path $logRoot "$stem.err.log")
  $argumentString = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
  $launchFile = $File
  if ([IO.Path]::GetExtension($File) -in @('.cmd','.bat')) {
    $launchFile = $env:ComSpec
    $argumentString = '/d /s /c "' + (ConvertTo-NativeArgument $File) + ' ' + $argumentString + '"'
  }
  $started = $null; $outReader = $null; $errReader = $null
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $lastHeartbeat = 0
  try {
    $options = @{ FilePath=$launchFile; PassThru=$true; WindowStyle='Hidden';
      WorkingDirectory=$WorkingDirectory; RedirectStandardOutput=$stdout; RedirectStandardError=$stderr }
    if ($argumentString) { $options.ArgumentList = $argumentString }
    $started = Start-Process @options
    $null = $started.Handle
    while ($true) {
      if (!$outReader -and (Test-Path -LiteralPath $stdout)) {
        $outReader = [IO.StreamReader]::new([IO.File]::Open($stdout, 'Open', 'Read', 'ReadWrite'))
      }
      if (!$errReader -and (Test-Path -LiteralPath $stderr)) {
        $errReader = [IO.StreamReader]::new([IO.File]::Open($stderr, 'Open', 'Read', 'ReadWrite'))
      }
      Write-LogLines $outReader
      Write-LogLines $errReader
      if ($started.HasExited) { break }
      if ($clock.Elapsed.TotalSeconds -gt $TimeoutSec) { throw "$Label timed out after $TimeoutSec seconds. Logs: $stdout" }
      if ($clock.Elapsed.TotalSeconds - $lastHeartbeat -ge 15) {
        $lastHeartbeat = [int]$clock.Elapsed.TotalSeconds
        $progress = ''
        if ($ProgressFile -and (Test-Path -LiteralPath $ProgressFile -PathType Leaf)) {
          $progress = ', {0:N1} MiB downloaded' -f ((Get-Item -LiteralPath $ProgressFile).Length / 1MB)
        }
        Write-Host ("... {0}: {1}s elapsed{2} (Ctrl+C to stop)" -f $Label, $lastHeartbeat, $progress) -ForegroundColor DarkGray
      }
      Start-Sleep -Milliseconds 250
    }
    $started.WaitForExit()
    Write-LogLines $outReader
    Write-LogLines $errReader
    # Start-Process can lose ExitCode when the process ends before its handle is read.
    $exitCode = $started.ExitCode
    if ($null -eq $exitCode) { throw "Could not read exit code for $Label. Logs: $stdout" }
    if ($exitCode -ne 0) {
      $failure = [InvalidOperationException]::new("$Label failed (exit $exitCode). Logs: $stdout and $stderr")
      $failure.Data['ExitCode'] = $exitCode
      $failure.Data['StderrLog'] = $stderr
      throw $failure
    }
    $script:LastStdoutLog = $stdout
    Write-Host ("OK ({0}s)" -f [int]$clock.Elapsed.TotalSeconds) -ForegroundColor Green
  } finally {
    if ($outReader) { $outReader.Dispose() }
    if ($errReader) { $errReader.Dispose() }
    if ($started -and !$started.HasExited) {
      # Only stop the child process tree created by this build step.
      # Cleanup must not replace the original timeout/build exception with a
      # permission error (some restricted shells deny taskkill enumeration).
      $killProcess = $null
      try {
        $killProcess = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList @('/PID',[string]$started.Id,'/T','/F') -WindowStyle Hidden -PassThru
        $null = $killProcess.Handle
        if (!$killProcess.WaitForExit(5000) -or $killProcess.ExitCode -ne 0) {
          Write-Warning "Could not stop child tree PID $($started.Id). Close that build process manually."
        }
      } catch { Write-Warning "Could not stop child PID $($started.Id): $($_.Exception.Message)" }
      finally { if ($killProcess) { $killProcess.Dispose() } }
    }
    if ($started) { $started.Dispose() }
  }
}

function Get-DownloadArguments {
  param([string]$Url, [string]$Partial, [int]$TimeoutSec, [bool]$Resume)
  $arguments = @(
    '--fail','--location','--silent','--show-error','--ipv4','--http1.1',
    '--connect-timeout',[string][Math]::Min(30, $TimeoutSec),'--max-time',[string]$TimeoutSec,
    '--speed-time','60','--speed-limit','1024','--user-agent','TelegramWidget-Builder/0.1'
  )
  if ($Resume) { $arguments += @('--continue-at','-') }
  return $arguments + @('--output',$Partial,$Url)
}

function Get-Download {
  param(
    [string]$Url, [string]$Destination, [string]$Sha256 = '', [int]$TimeoutSec = $DownloadTimeoutSec,
    [ValidateRange(1,5)][int]$Attempts = 3, [ValidateRange(0,30)][int]$RetryDelaySec = 2
  )
  $Destination = Assert-ProjectPath $Destination
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and $Sha256) {
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256) {
      Write-Host "Cached and verified: $([IO.Path]::GetFileName($Destination))"
      return
    }
  }
  $manualCache = Assert-ProjectPath (Join-Path $toolsRoot ([IO.Path]::GetFileName($Destination)))
  if ($Sha256 -and $manualCache -ne $Destination -and (Test-Path -LiteralPath $manualCache -PathType Leaf) -and
      (Get-FileHash -LiteralPath $manualCache -Algorithm SHA256).Hash -eq $Sha256) {
    Copy-Item -LiteralPath $manualCache -Destination $Destination -Force
    Write-Host "Imported and verified local archive: $manualCache"
    return
  }
  $partial = Assert-ProjectPath ($Destination + '.part')
  if ($Sha256 -and (Test-Path -LiteralPath $partial -PathType Leaf) -and
      (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -eq $Sha256) {
    Move-Item -LiteralPath $partial -Destination $Destination -Force
    Write-Host "Recovered complete and verified download: $([IO.Path]::GetFileName($Destination))"
    return
  }
  $downloadClock = [Diagnostics.Stopwatch]::StartNew()
  $forceFresh = $false
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $remaining = [int][Math]::Floor($TimeoutSec - $downloadClock.Elapsed.TotalSeconds)
    if ($remaining -le 0) { throw "Download time budget ($TimeoutSec seconds) exhausted: $Url. Partial data is kept at $partial" }
    $resume = !$forceFresh -and !!$Sha256 -and (Test-Path -LiteralPath $partial -PathType Leaf) -and (Get-Item -LiteralPath $partial).Length -gt 0
    Write-Host ("Attempt {0}/{1}: {2}; {3}s remaining" -f $attempt,$Attempts,$Url,$remaining)
    if ($resume) { Write-Host 'Resuming the verified archive transfer from the existing .part file.' }
    $arguments = Get-DownloadArguments -Url $Url -Partial $partial -TimeoutSec $remaining -Resume $resume
    try {
      Invoke-BuildStep -Label "Download $([IO.Path]::GetFileName($Destination)) attempt $attempt" -File $script:CurlPath -TimeoutSec ($remaining + 10) -ProgressFile $partial -Arguments $arguments
      break
    } catch {
      $failure = $_.Exception
      $code = $failure.Data['ExitCode']
      $details = ''
      if ($failure.Data['StderrLog'] -and (Test-Path -LiteralPath $failure.Data['StderrLog'])) {
        $details = Get-Content -LiteralPath $failure.Data['StderrLog'] -Raw
      }
      $transient = $code -in @(5,6,7,18,28,35,52,55,56,92)
      if ($code -eq 22 -and $details -match '(?:error:|HTTP[^\r\n]*?)\s*(?:408|429|5\d\d)\b') { $transient = $true }
      if ($resume -and ($code -eq 33 -or ($code -eq 22 -and $details -match '(?:error:|HTTP[^\r\n]*?)\s*416\b'))) {
        $forceFresh = $true
        $transient = $true
        Write-Warning 'Server does not support resuming. The next attempt will restart this partial download.'
      }
      if (!$transient -or $attempt -ge $Attempts -or $downloadClock.Elapsed.TotalSeconds -ge $TimeoutSec) { throw }
      $delay = [Math]::Min($RetryDelaySec * $attempt, [Math]::Max(0, [int]($TimeoutSec - $downloadClock.Elapsed.TotalSeconds)))
      Write-Warning "Temporary network error (curl $code). Retrying in $delay seconds; partial download is preserved."
      if ($delay -gt 0) { Start-Sleep -Seconds $delay }
    }
  }
  if ($Sha256 -and (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
    $rejected = Assert-ProjectPath ($partial + '.rejected-' + [guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $partial -Destination $rejected
    throw "SHA256 mismatch. The file will not be used; kept for diagnostics at $rejected"
  }
  Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Get-Checksum([string]$Text, [string]$Name) {
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $Name) { return $Matches[1].ToLowerInvariant() }
  }
  throw "Checksum not found for $Name"
}

function Expand-VerifiedZip([string]$Archive, [string]$Destination, [string]$ExpectedFile, [switch]$SkipUnixSymlinks) {
  $Destination = Assert-ProjectPath $Destination
  $marker = Join-Path $Destination '.telegram-extracted.sha256'
  $hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
  if ((Test-Path -LiteralPath $marker) -and (Get-Content -LiteralPath $marker -Raw).Trim() -eq $hash -and
      (Test-Path -LiteralPath (Join-Path $Destination $ExpectedFile))) { return }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Add-Type -AssemblyName System.IO.Compression
  $skippedLinks = [Collections.Generic.List[string]]::new()
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    foreach ($entry in $zip.Entries) {
      # Validate without legacy .NET MAX_PATH limitations on SDK header paths.
      if ($entry.FullName -match '(^|[\\/])\.\.([\\/]|$)|^[\\/]|:') {
        throw "Unsafe archive entry: $($entry.FullName)"
      }
      if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
        # OBS source releases contain Unix-only CI/formatting shortcuts. They
        # are not needed by the Windows CMake build and must not be extracted.
        if (!$SkipUnixSymlinks -or $entry.FullName -notmatch '^[^/]+/(?:\.github/scripts|build-aux)/[^/]+$') {
          throw "Unsafe archive entry: $($entry.FullName)"
        }
        $skippedLinks.Add($entry.FullName)
      }
    }
  } finally { $zip.Dispose() }
  $extractArchive = $Archive
  if ($skippedLinks.Count -gt 0) {
    # Keep the original SHA-verified download unchanged. Sanitize only a
    # disposable build copy, never materializing a symlink on disk.
    $extractArchive = Assert-ProjectPath ($Archive + '.windows.zip')
    Copy-Item -LiteralPath $Archive -Destination $extractArchive -Force
    $filteredZip = [IO.Compression.ZipFile]::Open($extractArchive, 'Update')
    try {
      foreach ($name in $skippedLinks) { $filteredZip.GetEntry($name).Delete() }
    } finally { $filteredZip.Dispose() }
    Write-Host "Skipping $($skippedLinks.Count) Unix-only build shortcuts (original archive unchanged)."
  }
  Write-Host "Extracting $([IO.Path]::GetFileName($Archive)) ..."
  if ($script:CMakePath) {
    Invoke-BuildStep -Label "Extract $([IO.Path]::GetFileName($Archive))" -File $script:CMakePath -WorkingDirectory $Destination -Arguments @('-E','tar','xf',$extractArchive)
  } else {
    Expand-Archive -LiteralPath $extractArchive -DestinationPath $Destination -Force
  }
  if (!(Test-Path -LiteralPath (Join-Path $Destination $ExpectedFile))) { throw "Archive has unexpected contents: $Archive" }
  Set-Content -LiteralPath $marker -Value $hash -Encoding ASCII
}

function Find-BuildTools {
  $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (!(Test-Path -LiteralPath $locator)) { return $null }
  $found = & $locator -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or !$found) { return $null }
  $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include'
  $hasSdk = @(Get-ChildItem -LiteralPath $sdk -Directory -ErrorAction SilentlyContinue | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'um\Windows.h')) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt\corecrt.h')) -and
    (Test-Path -LiteralPath (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Lib\$($_.Name)\um\x64\kernel32.lib"))
  }).Count -gt 0
  if (!$hasSdk) { return $null }
  return ([string]$found).Trim()
}

function Test-InstallConfirmation([AllowNull()][string]$Value) {
  return ([string]$Value).Trim() -ieq 'YES'
}

if ($FunctionsOnly) { return }

$transcriptStarted = $false
try {
  if (![Environment]::Is64BitOperatingSystem -or ![Environment]::Is64BitProcess) { throw 'Run the script in 64-bit PowerShell on Windows x64.' }
  Set-Location -LiteralPath $projectRoot
  New-Item -ItemType Directory -Force -Path $toolsRoot,$logRoot | Out-Null
  $logFile = Join-Path $logRoot ('build-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
  Start-Transcript -LiteralPath $logFile | Out-Null
  $transcriptStarted = $true
  Write-Host "Telegram Widget: full Windows x64 build" -ForegroundColor Cyan
  Write-Host "Project: $projectRoot`nLog: $logFile"
  Write-Host 'Downloads stay inside build/bootstrap. OBS and StreamOverlay are not modified.'
  $script:CurlPath = (Get-Command curl.exe -ErrorAction Stop).Source
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-sdk.json') -Raw | ConvertFrom-Json

  $vsPath = Find-BuildTools
  if (!$vsPath) {
    Write-Host 'Visual Studio 2022 C++ Build Tools and Windows SDK are required (several GB).' -ForegroundColor Yellow
    if (!$InstallBuildTools) {
      $answer = Read-Host 'Install the Microsoft build tools? This changes the system, not OBS. Type YES to continue'
      if (!(Test-InstallConfirmation $answer)) { throw 'Build tools not installed. Nothing else was changed. Re-run when ready.' }
    }
    $installer = Join-Path $toolsRoot 'vs_BuildTools.exe'
    Get-Download 'https://aka.ms/vs/17/release/vs_BuildTools.exe' $installer '' 120
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft installer signature verification failed.' }
    Write-Host 'Installing Build Tools. Windows may ask for administrator permission. Do not close this terminal.'
    $installProcess = Start-Process -FilePath $installer -ArgumentList @('--wait','--passive','--norestart','--nocache','--add','Microsoft.VisualStudio.Workload.VCTools','--add','Microsoft.VisualStudio.Component.Windows11SDK.26100','--includeRecommended') -Verb RunAs -WindowStyle Hidden -PassThru
    $installClock = [Diagnostics.Stopwatch]::StartNew()
    try {
      while (!$installProcess.HasExited) {
        if ($installClock.Elapsed.TotalMinutes -gt 90) { throw 'Build Tools installation exceeded 90 minutes. Check the Microsoft installer before continuing.' }
        Write-Host ("... Microsoft installer: {0}s elapsed" -f [int]$installClock.Elapsed.TotalSeconds)
        Start-Sleep -Seconds 15
      }
      $installProcess.WaitForExit()
      if ($installProcess.ExitCode -eq 3010) { throw 'Microsoft tools installed. Restart Windows, then run Build.cmd again.' }
      if ($installProcess.ExitCode -ne 0) { throw "Microsoft installer failed: $($installProcess.ExitCode)" }
    } finally { $installProcess.Dispose() }
    $vsPath = Find-BuildTools
    if (!$vsPath) { throw 'C++/Windows SDK installation is not complete. Restart Windows and run again.' }
  }
  Write-Host "Compiler: $vsPath"

  $cmakeVersion = $manifest.cmakeVersion
  $cmakeName = "cmake-$cmakeVersion-windows-x86_64.zip"
  $cmakeBase = "https://github.com/Kitware/CMake/releases/download/v$cmakeVersion"
  $cmakeSums = Join-Path $toolsRoot 'cmake-SHA256.txt'
  Get-Download "$cmakeBase/cmake-$cmakeVersion-SHA-256.txt" $cmakeSums '' 60
  $cmakeHash = Get-Checksum (Get-Content -LiteralPath $cmakeSums -Raw) $cmakeName
  $cmakeZip = Join-Path $toolsRoot $cmakeName
  Get-Download "$cmakeBase/$cmakeName" $cmakeZip $cmakeHash
  Expand-VerifiedZip $cmakeZip (Join-Path $toolsRoot 'cmake') "cmake-$cmakeVersion-windows-x86_64/bin/cmake.exe"
  $cmake = Join-Path $toolsRoot "cmake/cmake-$cmakeVersion-windows-x86_64/bin/cmake.exe"
  $script:CMakePath = $cmake

  $nodeSums = Join-Path $toolsRoot 'node-SHASUMS256.txt'
  Get-Download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' $nodeSums '' 60
  $nodeText = Get-Content -LiteralPath $nodeSums -Raw
  $nodeMatch = [regex]::Match($nodeText, '(?m)^([a-fA-F0-9]{64})\s+\*?(node-v24\.\d+\.\d+-win-x64\.zip)\s*$')
  if (!$nodeMatch.Success) { throw 'Node.js 24 Windows x64 archive not found in official checksums.' }
  $nodeName = $nodeMatch.Groups[2].Value
  $nodeVersion = [regex]::Match($nodeName, '^node-(v24\.\d+\.\d+)-win-x64\.zip$').Groups[1].Value
  $nodeZip = Join-Path $toolsRoot $nodeName
  Get-Download "https://nodejs.org/dist/$nodeVersion/$nodeName" $nodeZip $nodeMatch.Groups[1].Value
  $nodeDirectoryName = $nodeName -replace '\.zip$',''
  Expand-VerifiedZip $nodeZip (Join-Path $toolsRoot 'node') "$nodeDirectoryName/node.exe"
  $nodeDirectory = Join-Path $toolsRoot "node/$nodeDirectoryName"
  $node = Join-Path $nodeDirectory 'node.exe'
  $npm = Join-Path $nodeDirectory 'npm.cmd'
  $env:PATH = "$nodeDirectory;$(Split-Path -Parent $cmake);$env:PATH"
  $env:npm_config_cache = Join-Path $buildRoot 'npm-cache'
  $env:npm_config_fetch_retries = '1'
  $env:npm_config_fetch_timeout = '60000'

  $obsArchive = $manifest.archives | Where-Object name -eq 'obs-source'
  $obsZip = Join-Path $toolsRoot $obsArchive.file
  Get-Download $obsArchive.url $obsZip $obsArchive.sha256
  $obsParent = Join-Path $toolsRoot 'obs-source'
  $obsDirectoryName = 'obs-studio-' + $manifest.obsVersion
  Expand-VerifiedZip $obsZip $obsParent "$obsDirectoryName/CMakeLists.txt" -SkipUnixSymlinks
  $obsSource = Join-Path $obsParent $obsDirectoryName
  $obsDeps = Join-Path $obsSource '.deps'
  New-Item -ItemType Directory -Force -Path $obsDeps | Out-Null
  foreach ($archive in ($manifest.archives | Where-Object name -ne 'obs-source')) {
    $zipPath = Join-Path $obsDeps $archive.file
    Get-Download $archive.url $zipPath $archive.sha256
    $destination = Join-Path $obsDeps $archive.destination
    $expected = if ($archive.name -eq 'qt6') { 'lib/cmake/Qt6/Qt6Config.cmake' } else { 'share/obs-deps/VERSION' }
    Expand-VerifiedZip $zipPath $destination $expected
    Set-Content -LiteralPath (Join-Path $obsDeps ".dependency_$($archive.name)_x64.sha256") -Value $archive.sha256 -NoNewline -Encoding ASCII
  }
  $prebuilt = Join-Path $obsDeps (($manifest.archives | Where-Object name -eq 'prebuilt').destination)
  $qt = Join-Path $obsDeps (($manifest.archives | Where-Object name -eq 'qt6').destination)

  $browserMetadata = Join-Path $toolsRoot 'obs-browser-submodule.json'
  Get-Download "https://api.github.com/repos/obsproject/obs-studio/contents/plugins/obs-browser?ref=$($manifest.obsVersion)" $browserMetadata '' 60
  $browserCommit = (Get-Content -LiteralPath $browserMetadata -Raw | ConvertFrom-Json).sha
  if ($browserCommit -notmatch '^[a-f0-9]{40}$') { throw 'Invalid obs-browser submodule revision.' }
  $browserInclude = Join-Path $toolsRoot "obs-browser-$browserCommit"
  New-Item -ItemType Directory -Force -Path $browserInclude | Out-Null
  Get-Download "https://raw.githubusercontent.com/obsproject/obs-browser/$browserCommit/panel/browser-panel.hpp" (Join-Path $browserInclude 'browser-panel.hpp') '' 60

  $obsNative = Join-Path $buildRoot 'obs-sdk-build'
  $obsSdk = Join-Path $buildRoot 'obs-sdk'
  Invoke-BuildStep -Label 'Configure OBS development SDK' -File $cmake -Arguments @(
    '-S',$obsSource,'-B',$obsNative,'-G',$manifest.generator,'-A','x64',
    "-DCMAKE_GENERATOR_INSTANCE=$vsPath","-DCMAKE_PREFIX_PATH=$prebuilt;$qt",'-DOBS_CMAKE_VERSION=3.0.0',
    "-DOBS_VERSION_OVERRIDE=$($manifest.obsVersion)",'-DENABLE_PLUGINS=OFF','-DENABLE_FRONTEND=OFF',
    '-DENABLE_BROWSER=OFF','-DENABLE_SCRIPTING=OFF','-DCMAKE_ENABLE_SCRIPTING=OFF'
  )
  Invoke-BuildStep -Label 'Compile OBS SDK libraries' -File $cmake -TimeoutSec 3600 -Arguments @('--build',$obsNative,'--target','obs-frontend-api','--config','Release','--parallel','4')
  Invoke-BuildStep -Label 'Install SDK inside project' -File $cmake -Arguments @('--install',$obsNative,'--component','Development','--config','Release','--prefix',$obsSdk)

  Invoke-BuildStep -Label 'Install JavaScript dependencies' -File $npm -Arguments @('ci','--no-audit','--no-fund','--workspaces=false')
  Invoke-BuildStep -Label 'Run widget tests' -File $npm -Arguments @('test')
  Invoke-BuildStep -Label 'Build browser UI and verify assets' -File $npm -Arguments @('run','build')
  $native = Join-Path $buildRoot 'native-complete'
  Invoke-BuildStep -Label 'Configure plugin DLL' -File $cmake -Arguments @(
    '-S',$projectRoot,'-B',$native,'-G',$manifest.generator,'-A','x64',
    "-DCMAKE_GENERATOR_INSTANCE=$vsPath","-DCMAKE_PREFIX_PATH=$obsSdk;$prebuilt;$qt","-DOBS_BROWSER_INCLUDE_DIR=$browserInclude",'-DTELEGRAM_WIDGET_BUILD_TESTS=ON'
  )
  Invoke-BuildStep -Label 'Compile telegram-widget.dll' -File $cmake -Arguments @('--build',$native,'--config','Release','--parallel','4')
  $nativeTestPath = $env:PATH
  try {
    $env:PATH = (Join-Path $qt 'bin') + ';' + $env:PATH
    Invoke-BuildStep -Label 'Test native paths and service process launch' -File (Join-Path $native 'Release/telegram-widget-path-test.exe') -Arguments @($node)
  } finally { $env:PATH = $nativeTestPath }
  $dll = Join-Path $native 'Release/telegram-widget.dll'
  if (!(Test-Path -LiteralPath $dll)) { throw 'The compiler did not produce telegram-widget.dll.' }
  $msvc = Get-ChildItem -LiteralPath (Join-Path $vsPath 'VC/Tools/MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  $dumpbin = Join-Path $msvc.FullName 'bin/Hostx64/x64/dumpbin.exe'
  Invoke-BuildStep -Label 'Verify DLL exports' -File $dumpbin -Arguments @('/exports',$dll)
  $exports = Get-Content -LiteralPath $script:LastStdoutLog -Raw
  foreach ($symbol in @('obs_module_load','obs_module_ver','obs_module_set_pointer')) {
    if ($exports -notmatch "\b$symbol\b") { throw "Missing OBS plugin export: $symbol" }
  }
  Invoke-BuildStep -Label 'Package plugin and local runtime' -File $node -Arguments @((Join-Path $PSScriptRoot 'package-windows.js'),'--dll',$dll,'--runtime',$node)
  $receipt = Get-Content -LiteralPath (Join-Path $projectRoot 'package/last-build.json') -Raw | ConvertFrom-Json
  $packageDirectory = Assert-ProjectPath $receipt.directory
  Copy-Item -LiteralPath (Join-Path $obsSource 'COPYING') -Destination (Join-Path $packageDirectory 'GPL-2.0.txt')
  $archivePath = Assert-ProjectPath ($packageDirectory + '.zip')
  Write-Host 'Creating distributable ZIP ...'
  Compress-Archive -LiteralPath $packageDirectory -DestinationPath $archivePath -CompressionLevel Optimal
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath ($archivePath + '.sha256') -Value "$archiveHash  $([IO.Path]::GetFileName($archivePath))" -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $projectRoot 'package/last-build-zip.txt') -Value $archivePath -Encoding UTF8
  Write-Host "`nBUILD COMPLETE: $archivePath" -ForegroundColor Green
  Write-Host 'The installed OBS has not been modified. The DLL still needs a runtime check in a separate OBS test profile.'
} catch {
  Write-Host "`nBUILD STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Send the files in $logRoot to continue diagnostics. No need to rerun everything blindly."
  throw
} finally {
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
