# Vérifie que chaque fichier copié dans Google Drive (lecteur G:) est bien en ligne et identique à l'original :
# Drive pour ordinateur attache à chaque fichier envoyé son identifiant (flux user.drive.id) et son empreinte MD5 en ligne (user.drive.md5).
#   .\verifier-envoi-gdrive.ps1 [-Source ...] [-Dest 'G:\Mon Drive\Mes médias'] [-AttenteMinutes 120]
param(
  [string]$Source = 'C:\Users\matth\HomelabDrive\Utilisateurs\admin',
  [string]$Dest = 'G:\Mon Drive\Mes médias',
  [int]$AttenteMinutes = 120
)
$files = Get-ChildItem -LiteralPath $Source -Recurse -File -Force | Where-Object { $_.Name -notlike '.homelab-*' }
Write-Host "$($files.Count) fichiers à vérifier. Calcul des empreintes des originaux…"
$todo = @{}
foreach ($f in $files) {
  $rel = $f.FullName.Substring($Source.Length + 1)
  $todo[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm MD5).Hash.ToLower()
}
$total = $todo.Count
$fin = (Get-Date).AddMinutes($AttenteMinutes)
$bad = @{}
while ($todo.Count -gt 0 -and (Get-Date) -lt $fin) {
  foreach ($rel in @($todo.Keys)) {
    $p = Join-Path $Dest $rel
    if (-not (Test-Path -LiteralPath $p)) { $bad[$rel] = 'absent de G:'; continue }
    try { $id = "$(Get-Content -LiteralPath $p -Stream 'user.drive.id' -ErrorAction Stop)" } catch { $id = '' }
    if (-not $id -or $id -like 'local-*') { continue }               # pas encore envoyé
    try { $md5 = "$(Get-Content -LiteralPath $p -Stream 'user.drive.md5' -ErrorAction Stop)".ToLower() } catch { $md5 = '' }
    if ($md5 -eq $todo[$rel]) { $todo.Remove($rel); $bad.Remove($rel) }
    elseif ($md5) { $bad[$rel] = "empreinte différente en ligne ($md5)" }
  }
  Write-Host ("[{0:HH:mm:ss}] en ligne et vérifiés : {1} / {2}" -f (Get-Date), ($total - $todo.Count), $total)
  if ($todo.Count -gt 0) { Start-Sleep -Seconds 30 }
}
if ($todo.Count -eq 0) {
  Write-Host "TERMINÉ : les $total fichiers sont en ligne sur Google Drive, identiques aux originaux."
} else {
  Write-Host "PAS FINI après $AttenteMinutes min : $($todo.Count) fichiers pas encore confirmés en ligne (Drive continue l'envoi)."
  $todo.Keys | Select-Object -First 15 | ForEach-Object { Write-Host "  - $_  $(if ($bad[$_]) { '(' + $bad[$_] + ')' })" }
  exit 2
}
