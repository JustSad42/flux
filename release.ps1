# Publishes a new Flux version: .\release.ps1 1.2.1 "What changed"
# Bumps the version, builds the signed installer, writes latest.json (what the in-app updater reads), commits, tags, pushes,
# and creates the GitHub release with the installer, its signature and latest.json.
# Needs: the updater signing key at ~/.tauri/flux.key (keep it safe: without it, installed copies can no longer update), gh signed in.
param(
  [Parameter(Mandatory)][string]$Version,
  [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = 'JustSad42/flux'

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3" }
$key = Join-Path $HOME '.tauri\flux.key'
if (-not (Test-Path $key)) { throw "Signing key not found at $key" }
if (git tag --list "v$Version") { throw "v$Version already exists" }

# 1. version everywhere (package.json, tauri.conf.json, Cargo.toml [package])
$utf8 = New-Object System.Text.UTF8Encoding $false
foreach ($f in 'package.json', 'src-tauri\tauri.conf.json') {
  $t = [IO.File]::ReadAllText("$PSScriptRoot\$f")
  $t = [regex]::Replace($t, '"version":\s*"[^"]+"', "`"version`": `"$Version`"", 1)
  [IO.File]::WriteAllText("$PSScriptRoot\$f", $t, $utf8)
}
$c = [IO.File]::ReadAllText("$PSScriptRoot\src-tauri\Cargo.toml")
$c = [regex]::Replace($c, '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`"", 1)
[IO.File]::WriteAllText("$PSScriptRoot\src-tauri\Cargo.toml", $c, $utf8)

# 2. signed build (the key has no password)
$env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($key).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
& "$PSScriptRoot\build-installer.ps1"
if ($LASTEXITCODE) { throw "build failed" }

# 3. release files
$nsis = "$PSScriptRoot\src-tauri\target\release\bundle\nsis"
$setup = Get-Item "$nsis\Flux_${Version}_x64-setup.exe"
$sig = Get-Item "$($setup.FullName).sig"
$out = New-Item -ItemType Directory -Force "$PSScriptRoot\release"
Get-ChildItem $out | Remove-Item -Force
$asset = "Flux_${Version}_x64-setup.exe"
Copy-Item $setup.FullName "$out\$asset"; Copy-Item $sig.FullName "$out\$asset.sig"
$latest = [ordered]@{
  version  = $Version
  notes    = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = [IO.File]::ReadAllText($sig.FullName).Trim()
      url       = "https://github.com/$repo/releases/download/v$Version/$asset"
    }
  }
}
[IO.File]::WriteAllText("$out\latest.json", ($latest | ConvertTo-Json -Depth 5), $utf8)

# 4. commit, tag, push, publish
git add -A
git commit -m "Flux $Version" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag "v$Version"
git push origin HEAD
git push origin "v$Version"
$notesText = if ($Notes) { $Notes } else { "Flux $Version" }
gh release create "v$Version" "$out\$asset" "$out\$asset.sig" "$out\latest.json" --repo $repo --title "Flux $Version" --notes $notesText
Write-Host "`nReleased Flux $Version. Installed copies will offer the update on their next start."
