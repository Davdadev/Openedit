# OpenEdit - DaVinci Resolve bridge installer (Windows).
#
#   powershell -ExecutionPolicy Bypass -File resolve\install.ps1 [-MenuScript] [-NoMenuScript]
#
# Nothing here modifies Resolve projects or preferences.
param([switch]$MenuScript, [switch]$NoMenuScript)
$ErrorActionPreference = "Continue"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $Here "openedit_bridge.py"
$ProgramData = if ($env:PROGRAMDATA) { $env:PROGRAMDATA } else { "C:\ProgramData" }
$Base = "C:\Program Files\Blackmagic Design\DaVinci Resolve"
$Api = if ($env:RESOLVE_SCRIPT_API) { $env:RESOLVE_SCRIPT_API } else { Join-Path $ProgramData "Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting" }
$Lib = if ($env:RESOLVE_SCRIPT_LIB) { $env:RESOLVE_SCRIPT_LIB } else { Join-Path $Base "fusionscript.dll" }
$Rpy = Join-Path $Base "ResolvePython\ResolvePython.exe"
$ScriptsDir = Join-Path $env:APPDATA "Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility"

function Ok($m)   { Write-Host "  ok    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  fail  $m" -ForegroundColor Red }

Write-Host "OpenEdit - DaVinci Resolve bridge setup`n"
Write-Host "1. DaVinci Resolve"
if (Test-Path (Join-Path $Base "Resolve.exe")) { Ok "found $Base" } else { Fail "DaVinci Resolve not found in $Base" }
if (Test-Path $Lib) { Ok "fusionscript: $Lib" } else { Fail "fusionscript.dll not found ($Lib). Set RESOLVE_SCRIPT_LIB." }
if (Test-Path (Join-Path $Api "Modules")) { Ok "scripting modules: $Api\Modules" } else { Warn "scripting modules folder missing; the bridge can load fusionscript directly" }

Write-Host "`n2. Python that can load fusionscript"
$candidates = @()
if ($env:OPENEDIT_RESOLVE_PYTHON) { $candidates += $env:OPENEDIT_RESOLVE_PYTHON }
foreach ($n in @("python3", "python", "py")) {
  $c = Get-Command $n -ErrorAction SilentlyContinue
  if ($c) { $candidates += $c.Source }
}
if (Test-Path $Rpy) { $candidates += $Rpy }
$chosen = $null
$probe = "import sys; sys.path.insert(0, sys.argv[1]); import openedit_bridge as ob; ob.load_script_module(); print('%d.%d' % sys.version_info[:2])"
foreach ($py in $candidates) {
  $env:RESOLVE_SCRIPT_API = $Api; $env:RESOLVE_SCRIPT_LIB = $Lib
  $out = & $py -c $probe $Here 2>&1
  if ($LASTEXITCODE -eq 0) { Ok "$py (Python $($out | Select-Object -Last 1)) loads fusionscript"; $chosen = $py; break }
  else { Warn "$py cannot load fusionscript: $($out | Select-Object -Last 1)" }
}
if (-not $chosen) { Fail "no compatible Python found. Install Python 3.11 from python.org (64-bit)"; $chosen = "python" }
Write-Host "`n   Tell the OpenEdit MCP server which interpreter to use:"
Write-Host "     setx OPENEDIT_RESOLVE_PYTHON `"$chosen`""

Write-Host "`n3. Allow external scripting (required, one time)"
Write-Host "   In DaVinci Resolve: Preferences > System > General > 'External scripting using' -> Local, then restart Resolve."

Write-Host "`n4. Connection check"
& $chosen $Bridge --doctor
if ($LASTEXITCODE -eq 0) { Ok "bridge connected to Resolve" } else { Warn "not connected yet - start Resolve, open a project, enable external scripting" }

Write-Host "`n5. Resolve menu script (Workspace > Scripts > OpenEdit Status)"
$install = $MenuScript
if (-not $MenuScript -and -not $NoMenuScript) {
  $ans = Read-Host "   Install it now? [y/N]"
  $install = $ans -match '^(y|yes)$'
}
if ($install) {
  New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
  $dest = Join-Path $ScriptsDir "OpenEdit Status.py"
  $text = Get-Content -Raw -Encoding UTF8 (Join-Path $Here "scripts\OpenEdit Status.py")
  $text = $text.Replace("__OPENEDIT_BRIDGE__", $Bridge).Replace("__OPENEDIT_PYTHON__", $chosen)
  [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding $false))
  Ok "installed $dest"
} else { Write-Host "   skipped" }
Write-Host "`nDone."
