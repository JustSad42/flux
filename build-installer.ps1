# Builds Flux-Setup.exe (a normal Windows installer you can send to anyone). Run in PowerShell, in this folder: .\build-installer.ps1
# Needs: Rust, Node, VS C++ build tools (setup-windows.ps1 installs them). The installer carries its own copy of mpv.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$res = 'src-tauri\resources\mpv'
New-Item -ItemType Directory -Force $res | Out-Null
if (-not (Test-Path "$res\mpv.exe")) {
  $find = {
    $dirs = @("$env:ProgramFiles\MPV Player", "$env:ProgramFiles\mpv", "$env:LOCALAPPDATA\Programs\mpv")
    $onPath = Get-Command mpv -ErrorAction SilentlyContinue
    if ($onPath) { $dirs += (Split-Path $onPath.Source) }
    $dirs | Where-Object { Test-Path "$_\mpv.exe" } | Select-Object -First 1
  }
  $dir = & $find
  if (-not $dir) { winget install -e --id shinchiro.mpv --accept-package-agreements --accept-source-agreements; $dir = & $find }
  if (-not $dir) { throw 'mpv.exe not found. Install it (winget install shinchiro.mpv) and run this again.' }
  Copy-Item "$dir\mpv.exe" $res
  Get-ChildItem $dir -Filter *.dll | Copy-Item -Destination $res
  Write-Host "Bundled mpv from $dir"
}

npm install
npx tauri icon app-icon.png
npx tauri build
$setup = Get-ChildItem 'src-tauri\target\release\bundle\nsis' -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $setup.FullName 'Flux-Setup.exe' -Force
Write-Host ("`nDone: {0}\Flux-Setup.exe ({1:N0} MB)" -f $PSScriptRoot, ((Get-Item 'Flux-Setup.exe').Length / 1MB))
