# Arrête le homelab (API + tunnel + script de surveillance)
Stop-ScheduledTask -TaskName Homelab -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'start-homelab\.ps1') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'homelab\\server\\server\.js') -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match 'localhost:7575')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Arrêté : $($_.Name) ($($_.ProcessId))" }
