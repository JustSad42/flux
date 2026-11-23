# One-time setup on the Windows PC. Run in PowerShell: .\setup-windows.ps1
$ErrorActionPreference = 'Stop'
winget install -e --id Rustlang.Rustup
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install -e --id shinchiro.mpv   # the playback engine (mpv.exe must end up on PATH, or set its path in Settings)
Write-Host "`nDone. Close and reopen PowerShell, then see README.md step 2."
