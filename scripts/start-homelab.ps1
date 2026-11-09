# Démarre le homelab : API (Node) + tunnel Cloudflare, puis publie l'adresse du tunnel sur GitHub Pages.
# Reste actif et relance tout ce qui plante.
$ErrorActionPreference = 'Continue'
$Root    = Split-Path -Parent $PSScriptRoot
$Server  = Join-Path $Root 'server'
$Logs    = Join-Path $Root 'logs'
$Port    = 7575
New-Item -ItemType Directory -Force $Logs | Out-Null

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { $cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

function Log($m) { $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $m"; Write-Host $line; Add-Content -Path (Join-Path $Logs 'homelab.log') -Value $line -Encoding utf8 }

function Start-Api {
  Log "Démarrage de l'API sur le port $Port"
  Start-Process -FilePath $node -ArgumentList "`"$Server\server.js`"" -WorkingDirectory $Server -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Logs 'api.out.log') -RedirectStandardError (Join-Path $Logs 'api.err.log')
}

function Start-Tunnel {
  $tlog = Join-Path $Logs 'tunnel.log'
  Remove-Item $tlog -ErrorAction SilentlyContinue
  Log 'Démarrage du tunnel Cloudflare'
  $p = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$Port") `
    -WindowStyle Hidden -PassThru -RedirectStandardError $tlog -RedirectStandardOutput (Join-Path $Logs 'tunnel.out.log')
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $tlog) {
      $m = Select-String -Path $tlog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value }
    }
  }
  if (-not $url) { Log "Impossible de récupérer l'URL du tunnel"; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; return $null }
  Log "Tunnel actif : $url"
  Publish-Url $url | Out-Null
  return $p
}

function Publish-Url($url) {
  $cfg = Join-Path $Root 'docs\config.json'
  $json = "{ `"apiUrl`": `"$url`" }"
  [IO.File]::WriteAllText($cfg, $json + "`n", (New-Object Text.UTF8Encoding $false))
  Push-Location $Root
  try {
    git add docs/config.json 2>$null
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
      git commit -m "Mise à jour de l'adresse du tunnel" --quiet 2>$null
      git push --quiet 2>&1 | ForEach-Object { Log "git: $_" }
      if ($LASTEXITCODE -eq 0) { Log 'Adresse publiée sur GitHub (le site se met à jour en ~1 min)' } else { Log 'ÉCHEC du git push — vérifie ta connexion GitHub' }
    }
  } finally { Pop-Location }
}

$api = Start-Api
Start-Sleep -Seconds 2
$tunnel = Start-Tunnel

while ($true) {
  Start-Sleep -Seconds 15
  if ($api.HasExited) { Log "L'API s'est arrêtée (code $($api.ExitCode)), relance…"; $api = Start-Api }
  if (-not $tunnel -or $tunnel.HasExited) { Log 'Le tunnel est tombé, relance…'; $tunnel = Start-Tunnel; if (-not $tunnel) { Start-Sleep 30 } }
}
