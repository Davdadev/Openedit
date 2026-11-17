# Install the OpenEdit Premiere Pro panel (Windows).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1            # junction to this folder
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Copy      # copy instead
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall # remove the panel
#
# The panel is unsigned, so PlayerDebugMode is enabled for CSXS 9-13
# (HKCU\Software\Adobe\CSXS.N, string value "1"). No admin rights needed.
param(
  [switch]$Copy,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

$BundleId = "com.openedit.premiere"
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtDir = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$Dest = Join-Path $ExtDir $BundleId

function Remove-Existing {
  if (Test-Path -LiteralPath $Dest) {
    $item = Get-Item -LiteralPath $Dest -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      # Junction: remove the link only, never the target's contents.
      [IO.Directory]::Delete($Dest)
    } else {
      Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    Write-Host "Removed: $Dest"
  }
}

if ($Uninstall) {
  Remove-Existing
  Write-Host "Restart Premiere Pro to finish. PlayerDebugMode and ~/.openedit/token were left as they are."
  exit 0
}

New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
Remove-Existing

if ($Copy) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  foreach ($name in @("CSXS", "host", "lib", "index.html", "panel.js", "package.json", ".debug")) {
    Copy-Item -LiteralPath (Join-Path $Src $name) -Destination $Dest -Recurse -Force
  }
  Write-Host "Copied panel to: $Dest"
} else {
  New-Item -ItemType Junction -Path $Dest -Target $Src | Out-Null
  Write-Host "Linked panel: $Dest -> $Src"
}

foreach ($v in 9..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "Enabled PlayerDebugMode for CSXS 9-13 (needed for unsigned extensions)."

$TokenDir = Join-Path $env:USERPROFILE ".openedit"
$TokenFile = Join-Path $TokenDir "token"
if (-not (Test-Path -LiteralPath $TokenFile) -or ((Get-Item -LiteralPath $TokenFile).Length -eq 0)) {
  New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hex = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  [IO.File]::WriteAllText($TokenFile, $hex)
  # Restrict the token to the current user.
  & icacls $TokenFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  Write-Host "Created token file: $TokenFile"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Quit Premiere Pro completely and start it again."
Write-Host "  2. Open a project, then Window > Extensions > OpenEdit."
Write-Host "  3. The panel should say 'Listening on 127.0.0.1:47821'."
Write-Host "  4. Check:  curl.exe -s http://127.0.0.1:47821/health"
Write-Host "  Remote debugging of the panel: http://localhost:8099 (Chrome)."
