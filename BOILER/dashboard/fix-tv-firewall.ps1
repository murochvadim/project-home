# Lets the Balcony TV (192.168.1.199) reach the dashboard on port 3000.
# Tightens the NetBird allow to the NetBird subnet, then removes the broad block.
# Touches ONLY port-3000 rules. Media / NetBird / localhost unaffected.

Write-Host "Tightening 'NetBird only' to 100.102.0.0/16 ..."
netsh advfirewall firewall set rule name="Boiler Dashboard - NetBird only" new remoteip=100.102.0.0/16

Write-Host "Removing broad 'block other inbound' ..."
netsh advfirewall firewall delete rule name="Boiler Dashboard - block other inbound"

Write-Host ""
Write-Host "=== Resulting port-3000 rules ==="
netsh advfirewall firewall show rule name="Boiler Dashboard - NetBird only"    | Select-String "Rule Name|RemoteIP|Action"
netsh advfirewall firewall show rule name="Dashboard 3000 - Balcony TV"        | Select-String "Rule Name|RemoteIP|Action"

Write-Host ""
Write-Host "DONE. Press Enter to close."
Read-Host
