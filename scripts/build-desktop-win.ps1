$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "==> Installing dependencies"
bun install

Write-Host "==> Updating Neutralino binaries"
bun x neu update

Write-Host "==> Building desktop app"
bun run build

# Match CI packaging layout for Windows.
$releaseDir = Join-Path $repoRoot 'release'
if (Test-Path $releaseDir) {
    Remove-Item $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseDir | Out-Null

Write-Host "==> Packaging release folder"
Copy-Item 'dist/Monochrome/resources.neu' $releaseDir
Copy-Item 'neutralino.config.json' $releaseDir
Copy-Item 'dist/Monochrome/extensions' -Recurse (Join-Path $releaseDir 'extensions')
Copy-Item 'dist/Monochrome/Monochrome-win_x64.exe' (Join-Path $releaseDir 'Monochrome.exe')

Write-Host "Done. Output is in: $releaseDir"
