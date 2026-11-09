# Lance le homelab automatiquement à chaque ouverture de session Windows (invisible).
# Désinstaller : Unregister-ScheduledTask -TaskName Homelab -Confirm:$false
$script = Join-Path $PSScriptRoot 'start-homelab.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Homelab' -Action $action -Trigger $trigger -Settings $settings -Description 'Homelab : API + tunnel Cloudflare' -Force | Out-Null
Write-Host 'Tâche "Homelab" installée : le homelab démarrera à chaque connexion.'
Write-Host 'Pour le lancer maintenant : Start-ScheduledTask -TaskName Homelab'
