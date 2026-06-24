# phonelink-reset.ps1 - HARD Phone Link ("Link to Windows") recovery.
# Resets the YourPhone (messaging) + CrossDevice (file-transfer) packages. This
# WIPES their app data, so afterward you must SIGN IN again and RE-SCAN THE QR on
# your phone. Last-resort fix - the proven one for the "connected but picture
# send fails" CrossDevice break. Triggered by the "Full Reset" button.
# ASCII-only (Windows PowerShell 5.1 reads this as ANSI).
$ErrorActionPreference = 'SilentlyContinue'

# 1. stop the running pieces
Stop-Process -Name PhoneExperienceHost, YourPhoneAppProxy -Force
Start-Sleep -Seconds 2

# 2. reset both packages (clears the corrupted state; per-user, no elevation)
$done = @()
foreach ($n in 'Microsoft.YourPhone', 'MicrosoftWindows.CrossDevice') {
  $pkg = Get-AppxPackage -Name $n
  if ($pkg) {
    Get-AppxPackage -Name $n | Reset-AppxPackage
    $done += $n
  }
}

# 3. relaunch Phone Link (cold start after a reset is slow)
Start-Process 'explorer.exe' 'shell:appsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App'
Start-Sleep -Seconds 18

$p = Get-Process PhoneExperienceHost
if ($p -and $done.Count -ge 1) {
  Write-Output "OK: Phone Link reset done. Now SIGN IN and RE-SCAN THE QR on your phone, then try sending again."
} elseif ($done.Count -ge 1) {
  Write-Output "OK: Reset done but Phone Link did not relaunch - open it from the Start menu, sign in, and re-scan the QR."
} else {
  Write-Output "ERR: Could not find the Phone Link packages to reset."
}
