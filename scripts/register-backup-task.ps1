# Run this once (as Administrator) to register the daily backup scheduled task

$taskName   = "ProjectHome-Backup"
$scriptPath = "C:\Users\muroc\project_home\scripts\laptop-backup.ps1"
$logPath    = "C:\Users\muroc\project_home\scripts\backup.log"

# Remove existing task if any
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" *>> `"$logPath`" 2>&1"

# Run daily at 02:00
$trigger = New-ScheduledTaskTrigger -Daily -At "02:00"

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RunOnlyIfNetworkAvailable `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType S4U `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName   $taskName `
    -Action     $action `
    -Trigger    $trigger `
    -Settings   $settings `
    -Principal  $principal `
    -Description "Daily backup of project_home to QNAP Laptop_Data"

Write-Host "Task '$taskName' registered — runs daily at 02:00"
Write-Host "To run now: Start-ScheduledTask -TaskName '$taskName'"
