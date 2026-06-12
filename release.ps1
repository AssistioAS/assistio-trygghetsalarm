param(
    [Parameter(Mandatory=$true)]
    [string]$version
)

# Oppdater versjon i konfig-filer
$tauriConf = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$tauriConf.version = $version
$tauriConf | ConvertTo-Json -Depth 10 | Set-Content "src-tauri/tauri.conf.json"

$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
$packageJson.version = $version
$packageJson | ConvertTo-Json -Depth 10 | Set-Content "package.json"

Write-Host "Versjon oppdatert til $version" -ForegroundColor Green

# Git commit og tag
git add .
git commit -m "Release v$version"
git tag "v$version"
git push
git push --tags

Write-Host ""
Write-Host "Release v$version startet!" -ForegroundColor Cyan
Write-Host "Se status: https://github.com/AssistioAS/assistio-trygghetsalarm/actions" -ForegroundColor Cyan
