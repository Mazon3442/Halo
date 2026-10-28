# Builds a signed Halo installer and the latest.json the in-app updater reads.
#
#   1. Bump "version" in tauri.conf.json and Cargo.toml.
#   2. .\release.ps1
#   3. Make a GitHub release tagged v<version> and upload the three files it prints.
#
# Installed copies check https://github.com/Mazon3442/Halo/releases/latest/download/latest.json at
# launch, so the newest (non-draft, non-prerelease) release is what they update to.
#
# Signing uses the updater key in ~/.tauri/halo-updater.key. Keep it safe and out of git: if it's
# lost, installed copies can never verify an update again.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$key = Join-Path $HOME ".tauri\halo-updater.key"
if (-not (Test-Path $key)) { throw "Updater signing key not found at $key" }
$env:TAURI_SIGNING_PRIVATE_KEY = $key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

$version = (Get-Content tauri.conf.json -Raw | ConvertFrom-Json).version

cargo build --release
if ($LASTEXITCODE) { throw "cargo build failed" }
npx --yes @tauri-apps/cli@2 build
if ($LASTEXITCODE) { throw "tauri build failed" }

$dir = "target\release\bundle\nsis"
$installer = "Halo_${version}_x64-setup.exe"
$signature = (Get-Content "$dir\$installer.sig" -Raw).Trim()
$notes = Read-Host "Release notes (one line, shown in the update prompt; Enter for none)"

$manifest = [ordered]@{
  version  = $version
  notes    = $notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url       = "https://github.com/Mazon3442/Halo/releases/download/v$version/$installer"
    }
  }
}
# WriteAllText writes UTF-8 without a BOM, which the updater's JSON parser needs.
[IO.File]::WriteAllText((Join-Path (Resolve-Path $dir) "latest.json"), ($manifest | ConvertTo-Json -Depth 5))

Write-Host ""
Write-Host "Release v$version ready. Upload these to a GitHub release tagged v${version}:"
Write-Host "  $dir\$installer"
Write-Host "  $dir\$installer.sig"
Write-Host "  $dir\latest.json"
