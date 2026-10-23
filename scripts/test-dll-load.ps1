param([string]$ObsPath = 'C:\Program Files\obs-studio')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$receipt = Get-Content -LiteralPath (Join-Path $root 'package/last-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$binary = Join-Path $receipt.directory 'obs-plugins/64bit/telegram-widget.dll'
$obsBin = Join-Path (Resolve-Path -LiteralPath $ObsPath).Path 'bin/64bit'
if (!(Test-Path -LiteralPath $binary)) { throw 'Packaged plugin DLL is missing.' }
if (!(Test-Path -LiteralPath (Join-Path $obsBin 'obs.dll'))) { throw 'OBS libraries are missing.' }
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.dllSha256) {
  throw 'Packaged DLL does not match its build receipt.'
}
# Load in this disposable PowerShell process, not in a running OBS instance.
# No obs_module_load call: that requires the real OBS UI and its event loop.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class WidgetDllProbe {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr AddDllDirectory(string path);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)]
  static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32")] static extern bool RemoveDllDirectory(IntPtr cookie);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate uint Version();
  public static uint Check(string dll, string obsBin) {
    IntPtr cookie = AddDllDirectory(obsBin);
    if (cookie == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr module = IntPtr.Zero;
    try {
      module = LoadLibraryEx(dll, IntPtr.Zero, 0x100 | 0x400 | 0x800);
      if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Plugin DLL or an OBS/Qt import cannot be loaded");
      foreach (string name in new [] {"obs_module_load", "obs_module_unload", "obs_module_set_pointer", "obs_module_ver"})
        if (GetProcAddress(module, name) == IntPtr.Zero) throw new Exception("Missing export: " + name);
      var version = (Version)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module, "obs_module_ver"), typeof(Version));
      return version();
    } finally {
      if (module != IntPtr.Zero) FreeLibrary(module);
      RemoveDllDirectory(cookie);
    }
  }
}
'@
$apiVersion = [WidgetDllProbe]::Check($binary, $obsBin)
$result = [ordered]@{
  dllSha256 = $receipt.dllSha256
  obsVersion = (Get-Item -LiteralPath (Join-Path $obsBin 'obs64.exe')).VersionInfo.ProductVersion
  qtVersion = (Get-Item -LiteralPath (Join-Path $obsBin 'Qt6Core.dll')).VersionInfo.ProductVersion
  importLoadTest = 'passed'
  pluginApiVersion = $apiVersion
  nativeObsUiTest = 'not-run'
  checkedAt = [DateTime]::UtcNow.ToString('o')
}
$report = Join-Path $root 'build/dll-load-test.json'
$result | ConvertTo-Json | Set-Content -LiteralPath $report -Encoding UTF8
$result | ConvertTo-Json
Write-Host 'DLL imports resolve against the installed OBS/Qt. This does not replace the OBS panel/source test.'
