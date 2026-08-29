#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
Remove-Item -Recurse -Force dist, build

$Major = 0
$Minor = 1
$BuildDate = [datetime]'2026-08-29'
$Now = Get-Date
$Days = [math]::Floor(($Now - $BuildDate).TotalDays)
$DaysString = '{0:D4}' -f $Days
$Timestamp = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$Last4String = ($Timestamp % 10000).ToString('D4')
$Version = "$Major.$Minor.$DaysString.$Last4String"

Write-Host "==> Building Open Axle v$Version with PyInstaller..."
pyinstaller --noconfirm --clean --distpath dist/output --workpath build axle.spec

Write-Host "==> Copying skills (excluding __pycache__)..."
if (Test-Path -Path dist/output/skills) {
    Remove-Item -Path dist/output/skills -Recurse -Force
}
New-Item -ItemType Directory -Path dist/output -Force | Out-Null
Copy-Item -Path skills -Destination dist/output/skills -Recurse -Force
Get-ChildItem -Path dist/output/skills -Directory -Recurse -Filter __pycache__ | Remove-Item -Recurse -Force

Write-Host "==> Packaging dist/output into dist/open-axle_${Version}.zip..."
tar -czf "dist/open-axle_${Version}.zip" -C dist/output .

Write-Host "Build complete: dist/open-axle_${Version}.zip"
