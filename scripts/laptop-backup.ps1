# Laptop Project Backup — uploads project_home zip to QNAP Laptop_Data via HTTP API
# Scheduled daily via Windows Task Scheduler
# Status written to dashboard\backup-status.json for dashboard display

param(
    [string]$SourcePath  = "C:\Users\muroc\project_home",
    [string]$StatusFile  = "C:\Users\muroc\project_home\BOILER\dashboard\backup-status.json",
    [string]$QnapHost    = "192.168.1.155",
    [string]$QnapUser    = "",
    [string]$QnapPass    = "",
    [string]$QnapDest    = "/Laptop_Data",
    [int]$KeepFiles      = 7
)

# Load credentials from Windows environment variables if not passed as params
if (-not $QnapUser) { $QnapUser = $env:QNAP_USER }
if (-not $QnapPass) { $QnapPass = $env:QNAP_PASS }
if (-not $QnapUser -or -not $QnapPass) {
    throw "QNAP credentials missing. Set QNAP_USER and QNAP_PASS as Windows environment variables."
}

$ErrorActionPreference = "Stop"
$StartTime = Get-Date

function Write-Status($status, $message, $file="", $sizeMb=0, $error="") {
    $obj = @{
        status    = $status
        message   = $message
        file      = $file
        size_mb   = $sizeMb
        error     = $error
        started   = $StartTime.ToString("o")
        finished  = (Get-Date).ToString("o")
        source    = $SourcePath
        dest      = "qnap:$QnapDest"
    }
    $obj | ConvertTo-Json | Set-Content -Path $StatusFile -Encoding UTF8
}

function Get-QnapSid {
    $b64pass = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($QnapPass))
    $url = "https://${QnapHost}/cgi-bin/authLogin.cgi?user=${QnapUser}&pwd=${b64pass}&serviceKey=1"
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing
    if ($resp.Content -match 'authPassed><!\[CDATA\[1\]\]>') {
        if ($resp.Content -match 'authSid><!\[CDATA\[([^\]]+)\]\]>') {
            return $Matches[1]
        }
    }
    throw "QNAP authentication failed"
}

function Remove-OldBackups($sid) {
    $listUrl = "https://${QnapHost}/cgi-bin/filemanager/utilRequest.cgi?func=get_list&path=${QnapDest}&sid=${sid}&limit=100&sort=modified&dir=DESC"
    $resp = Invoke-WebRequest -Uri $listUrl -UseBasicParsing
    $data = $resp.Content | ConvertFrom-Json
    $files = $data.datas | Where-Object { $_.isfolder -eq 0 -and $_.filename -like "project_home_*.zip" } | Sort-Object epochmt -Descending
    if ($files.Count -gt $KeepFiles) {
        $toDelete = $files | Select-Object -Skip $KeepFiles
        foreach ($f in $toDelete) {
            $delPath = "${QnapDest}/$($f.filename)"
            $delUrl = "https://${QnapHost}/cgi-bin/filemanager/utilRequest.cgi?func=delete&sid=${sid}&path=${QnapDest}&file_name=$([Uri]::EscapeDataString($f.filename))"
            Invoke-WebRequest -Uri $delUrl -UseBasicParsing | Out-Null
            Write-Host "Deleted old backup: $($f.filename)"
        }
    }
}

try {
    Write-Status "running" "Starting backup..."

    # ── Step 1: Create zip ────────────────────────────────────────
    $ts      = $StartTime.ToString("yyyy-MM-dd_HHmm")
    $zipName = "project_home_${ts}.zip"
    $zipPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), $zipName)

    Write-Host "Zipping $SourcePath -> $zipPath"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    # Exclude node_modules and .git to keep size small
    $exclude = @("node_modules", ".git", "*.log", "voice-uploads")
    $items = Get-ChildItem -Path $SourcePath -Recurse | Where-Object {
        $path = $_.FullName
        -not ($exclude | Where-Object { $path -match [regex]::Escape($_) })
    }
    Compress-Archive -Path $SourcePath -DestinationPath $zipPath -CompressionLevel Optimal
    $sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
    Write-Host "Zip created: ${sizeMb} MB"

    # ── Step 2: Auth to QNAP ─────────────────────────────────────
    Write-Host "Authenticating to QNAP..."
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    $sid = Get-QnapSid
    Write-Host "SID: $sid"

    # ── Step 3: Upload ────────────────────────────────────────────
    Write-Host "Uploading $zipName to QNAP $QnapDest..."
    $uploadUrl = "https://${QnapHost}/cgi-bin/filemanager/utilRequest.cgi?func=upload&type=standard&sid=${sid}&dest_path=${QnapDest}&overwrite=1"

    $fileBytes   = [System.IO.File]::ReadAllBytes($zipPath)
    $boundary    = [System.Guid]::NewGuid().ToString()
    $contentType = "multipart/form-data; boundary=$boundary"

    $bodyLines = @(
        "--$boundary",
        "Content-Disposition: form-data; name=`"file`"; filename=`"$zipName`"",
        "Content-Type: application/zip",
        "",
        [System.Text.Encoding]::GetEncoding("iso-8859-1").GetString($fileBytes),
        "--$boundary--"
    )
    $body = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetBytes($bodyLines -join "`r`n")

    $resp = Invoke-WebRequest -Uri $uploadUrl -Method POST -ContentType $contentType -Body $body -UseBasicParsing
    Write-Host "Upload response: $($resp.Content.Substring(0, [Math]::Min(200, $resp.Content.Length)))"

    # ── Step 4: Clean old backups ─────────────────────────────────
    Remove-OldBackups $sid

    # ── Step 5: Cleanup local temp zip ───────────────────────────
    Remove-Item $zipPath -Force

    Write-Status "ok" "Backup completed successfully" $zipName $sizeMb
    Write-Host "Done."

} catch {
    $errMsg = $_.Exception.Message
    Write-Host "ERROR: $errMsg"
    Write-Status "error" "Backup failed" "" 0 $errMsg
    exit 1
}
