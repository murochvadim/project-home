# netbird-mode.ps1 - flip the NetBird "home lan" route for the dashboard laptop.
#
#   -Mode Home    : DESELECT "home lan"  -> laptop reaches the LAN directly over
#                   Wi-Fi; ESP/OTA board flashing works. Run this when you get HOME.
#   -Mode Remote  : SELECT   "home lan"  -> laptop reaches home 192.168.1.0/24
#                   through the NetBird tunnel, waits for Postgres to become
#                   reachable, then cleanly restarts the dashboard. Run this when
#                   you take the laptop OUT.
#
# Two desktop shortcuts call this with the two modes (see the paired
# create-netbird-shortcuts.ps1). No Administrator rights needed - the NetBird CLI
# talks to the local service. Reversible; see memory incident_netbird_breaks_ota.
# ASCII-only (PS 5.1 reads this as ANSI, like cast-to-tv85.ps1).

param([Parameter(Mandatory = $true)][ValidateSet('Home', 'Remote')][string]$Mode)

$ErrorActionPreference = 'Continue'

$dashUrl = 'http://localhost:3000'
$openDash = $false

$nb = 'C:\Program Files\NetBird\netbird.exe'
if (-not (Test-Path $nb)) { $nb = 'netbird' }
$dashDir = 'C:\Users\muroc\project_home\BOILER\dashboard'
$log = Join-Path $env:USERPROFILE 'netbird-mode.log'

function Log($m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line
}
function Test-Tcp($h, $p, $ms = 1500) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $iar = $c.BeginConnect($h, $p, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne($ms)) { $c.EndConnect($iar); $c.Close(); return $true }
    $c.Close(); return $false
  } catch { return $false }
}

Write-Host ''
if ($Mode -eq 'Home') {
  Write-Host '== NetBird: HOME mode ==' -ForegroundColor Cyan
  & $nb routes deselect 'home lan'
  Log "HOME: deselected 'home lan'"
  Write-Host ''
  Write-Host "'home lan' route DESELECTED." -ForegroundColor Green
  Write-Host 'The laptop now reaches the LAN directly over Wi-Fi; ESP OTA flashing works.' -ForegroundColor Green
  $openDash = $true
}
else {
  Write-Host '== NetBird: REMOTE mode ==' -ForegroundColor Cyan
  & $nb routes select 'home lan'
  Log "REMOTE: selected 'home lan'"
  Write-Host ''
  Write-Host "'home lan' route SELECTED. Waiting for home Postgres (192.168.1.219:5432)..." -ForegroundColor Yellow
  $ok = $false
  for ($i = 0; $i -lt 15; $i++) {
    if (Test-Tcp '192.168.1.219' 5432 1500) { $ok = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($ok) {
    Write-Host 'DB reachable. Restarting the dashboard...' -ForegroundColor Green
    Push-Location $dashDir
    pm2 delete boiler-dashboard 2>$null | Out-Null
    pm2 start ecosystem.config.js | Out-Null
    Pop-Location
    Log 'REMOTE: DB reachable, dashboard restarted'
    Write-Host ''
    Write-Host 'Dashboard restarted. Open it at:  http://localhost:3000' -ForegroundColor Green
    Write-Host '  (from another NetBird device:   http://100.102.207.1:3000)' -ForegroundColor DarkGray
    $openDash = $true
  }
  else {
    Write-Host 'DB still NOT reachable after 15s. Check "netbird status" is Connected.' -ForegroundColor Red
    Log 'REMOTE: DB NOT reachable after select'
  }
}

Write-Host ''
& $nb routes list | Select-String -Pattern 'home lan' -Context 0, 2
Write-Host ''
if ($openDash) {
  Write-Host ('Opening dashboard: {0}' -f $dashUrl) -ForegroundColor Cyan
  Start-Process $dashUrl
}
Read-Host 'Done - press Enter to close'
