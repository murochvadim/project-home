# phonelink-restart.ps1 - LIGHT Phone Link ("Link to Windows") recovery.
# Restarts the app + re-registers the CrossDevice component. NO data loss,
# NO re-pair. Triggered by the "Restart Phone Link" button on Project Health.
# ASCII-only (Windows PowerShell 5.1 reads this as ANSI). Emits one line:
#   "OK: ..."  on success  /  "ERR: ..." on failure.
$ErrorActionPreference = 'SilentlyContinue'

# 1. stop the running pieces so the restart is clean
Stop-Process -Name PhoneExperienceHost, YourPhoneAppProxy -Force
Start-Sleep -Seconds 2

# 2. re-register CrossDevice (the file-transfer component) - this re-registers
#    the existing package for the user; it does NOT wipe data (that is Reset).
$pkg = Get-AppxPackage -Name MicrosoftWindows.CrossDevice
if ($pkg) {
  Add-AppxPackage -DisableDevelopmentMode -Register (Join-Path $pkg.InstallLocation 'AppxManifest.xml')
}

# 3. relaunch Phone Link
Start-Process 'explorer.exe' 'shell:appsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App'
Start-Sleep -Seconds 12

$p = Get-Process PhoneExperienceHost
if ($p) {
  Write-Output ("OK: Phone Link restarted (PID " + $p.Id + "). Give it a moment to reconnect, then try sending again.")
} else {
  Write-Output "ERR: Phone Link did not come back up after restart - try the Full Reset button."
}
