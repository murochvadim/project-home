' pm2-start.vbs — Windows Startup auto-launcher for the boiler-dashboard
'
' PERMANENT FIX (2026-05-26): replaced "pm2 resurrect" (which reads stale
' dump.pm2 — last saved snapshot of pm2 state, including snapshotted env
' vars from possibly weeks/months ago) with explicit "delete + start
' ecosystem.config.js" — this re-reads .env FRESH every boot.
'
' Without this, every time the user updated BOILER/dashboard/.env (HA
' token rotation, MQTT password change, new secret added), the next
' Windows reboot would resurrect the pm2 daemon with the old snapshot —
' causing the dashboard to crash-loop with "FATAL: <KEY> not set in
' environment" errors until manual `pm2 delete && pm2 start
' ecosystem.config.js` was run.
'
' This script runs HIDDEN (0) at user logon (location: user's Startup
' folder). It first deletes any boiler-dashboard instance pm2 might
' have auto-restored (or remembers from before shutdown), then starts
' fresh from ecosystem.config.js which reads .env at load time.
'
' If you ever add another pm2-managed process to this machine, add a
' corresponding "pm2 delete <name>" before the start line, OR rewrite
' to iterate over a list. Currently only boiler-dashboard is pm2-managed.
'
' Logs to %USERPROFILE%\.pm2\startup.log for debugging boot issues.
'
' Tracked in project repo at BOILER/dashboard/pm2-start.vbs — keep
' the file at this Startup-folder location in sync.

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\muroc\project_home\BOILER\dashboard && pm2 delete boiler-dashboard 2>nul & pm2 start ecosystem.config.js >> ""%USERPROFILE%\.pm2\startup.log"" 2>&1", 0, False
