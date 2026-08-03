# Creates two Desktop shortcuts that flip the NetBird "home lan" route via
# netbird-mode.ps1:  "NetBird - Home mode"  and  "NetBird - Remote mode".
# Re-run any time to recreate them. ASCII-only (PS 5.1 ANSI).

$script = 'C:\Users\muroc\project_home\BOILER\dashboard\netbird-mode.ps1'
$dashDir = 'C:\Users\muroc\project_home\BOILER\dashboard'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$icon = 'C:\Program Files\NetBird\netbird.exe,0'
$desktop = [Environment]::GetFolderPath('Desktop')
$wsh = New-Object -ComObject WScript.Shell

function New-ModeShortcut($name, $mode) {
  $lnk = $wsh.CreateShortcut((Join-Path $desktop ($name + '.lnk')))
  $lnk.TargetPath = $ps
  $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode {1}' -f $script, $mode
  $lnk.WorkingDirectory = $dashDir
  $lnk.Description = "Flip the NetBird 'home lan' route ($mode)"
  if (Test-Path 'C:\Program Files\NetBird\netbird.exe') { $lnk.IconLocation = $icon }
  $lnk.WindowStyle = 1
  $lnk.Save()
  Write-Host ("created: {0}" -f (Join-Path $desktop ($name + '.lnk'))) -ForegroundColor Green
}

New-ModeShortcut 'NetBird - Home mode'   'Home'
New-ModeShortcut 'NetBird - Remote mode' 'Remote'
Write-Host 'Done. Two shortcuts are on your Desktop.' -ForegroundColor Cyan
