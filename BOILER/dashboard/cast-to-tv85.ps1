# cast-to-tv85.ps1
# Opens the Windows "Cast" panel (Win+K) on the interactive desktop so the laptop
# can screen-mirror to the TV. Runs on the Windows dashboard host (the laptop),
# where the pm2 dashboard process lives in the user's logon session, so the
# keystroke reaches the desktop.
#
# WHY IT ONLY OPENS THE PANEL (does not auto-pick the TV):
#   - Windows deliberately blocks a background process from silently selecting a
#     screen-mirror target (a security boundary).
#   - Auto-matching the device by name via UI Automation is unsafe here: it grabs
#     ANY on-screen text containing "Samsung"/"TV" (e.g. the dashboard's own
#     "Samsung 85 QLED" heading), clicking the wrong thing.
#   - The TV's "Allow" prompt is a physical step on the TV regardless.
#   So the button opens the picker; the user makes the final 1 click + TV accept.
#
# ASCII ONLY: PowerShell 5.1 reads .ps1 as ANSI; non-ASCII chars corrupt the parse.

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Kbd { [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }
'@

$LWIN = 0x5B; $K = 0x4B; $UP = 0x2
# Press Win+K to open the Cast / Connect flyout on the user's desktop.
[Kbd]::keybd_event($LWIN, 0, 0, [UIntPtr]::Zero); [Kbd]::keybd_event($K, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Kbd]::keybd_event($K, 0, $UP, [UIntPtr]::Zero); [Kbd]::keybd_event($LWIN, 0, $UP, [UIntPtr]::Zero)

Write-Output "OK: Cast panel opened. Click 'Samsung 85' in the list, then accept the connection on the TV (choose 'Allow always' to skip the prompt next time)."
exit 0
