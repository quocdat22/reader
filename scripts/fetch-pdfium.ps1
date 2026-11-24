#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PdfiumBuild = "8125"
$ArchiveName = "pdfium-win-x64.tgz"
$DownloadUrl = "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/$PdfiumBuild/$ArchiveName"
$ExpectedArchiveSha256 = "9A964261760CFF52570AABF038AB346D3A5034DD8B30D0D5FE8861235D356B8B"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResourcesDir = Join-Path $RepoRoot "src-tauri\resources"
$DllTarget = Join-Path $ResourcesDir "pdfium.dll"
$LicenseTarget = Join-Path $ResourcesDir "PDFIUM-LICENSE.txt"
$VersionTarget = Join-Path $ResourcesDir "PDFIUM-VERSION.txt"

# Idempotent check: skip download if matching build is already present.
if (-not $Force -and (Test-Path -LiteralPath $DllTarget) -and (Test-Path -LiteralPath $VersionTarget)) {
    $versionContent = Get-Content -LiteralPath $VersionTarget -Raw
    if ($versionContent -match "(?m)^BUILD=$PdfiumBuild\r?$") {
        Write-Host "PDFium chromium/$PdfiumBuild is already present at $DllTarget (use -Force to re-download)."
        exit 0
    }
}

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    throw "tar.exe not found on PATH; Windows 10/11 built-in tar.exe is required to extract $ArchiveName."
}

New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("reader-pdfium-$PdfiumBuild-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $ArchivePath = Join-Path $TempDir $ArchiveName
    $ExtractDir = Join-Path $TempDir "extract"
    New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null

    # Ensure TLS 1.2+ on Windows PowerShell 5.1
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    Write-Host "Downloading PDFium chromium/$PdfiumBuild ($ArchiveName)..."
    $prevProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing
    } finally {
        $ProgressPreference = $prevProgress
    }

    Write-Host "Verifying SHA-256 checksum..."
    $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($ActualSha256 -ne $ExpectedArchiveSha256) {
        throw "SHA-256 mismatch for $ArchiveName!`n  Expected: $ExpectedArchiveSha256`n  Actual:   $ActualSha256"
    }

    Write-Host "Extracting bin/pdfium.dll, LICENSE, and VERSION..."
    & tar.exe -xzf $ArchivePath -C $ExtractDir bin/pdfium.dll LICENSE VERSION
    if ($LASTEXITCODE -ne 0) {
        throw "tar.exe exited with code $LASTEXITCODE while extracting $ArchiveName."
    }

    $ExtractedDll = Join-Path $ExtractDir "bin\pdfium.dll"
    $ExtractedLicense = Join-Path $ExtractDir "LICENSE"
    $ExtractedVersion = Join-Path $ExtractDir "VERSION"

    foreach ($required in @($ExtractedDll, $ExtractedLicense, $ExtractedVersion)) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Expected archive member missing after extraction: $required"
        }
    }

    # Replace target files cleanly (surface a clear message if pdfium.dll is locked by a running reader.exe).
    try {
        Copy-Item -LiteralPath $ExtractedDll -Destination $DllTarget -Force
        Copy-Item -LiteralPath $ExtractedLicense -Destination $LicenseTarget -Force
        Copy-Item -LiteralPath $ExtractedVersion -Destination $VersionTarget -Force
    } catch {
        throw "Failed to install pdfium.dll into $ResourcesDir (close any running Reader instance and retry): $($_.Exception.Message)"
    }

    $DllHash = (Get-FileHash -LiteralPath $DllTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Installed PDFium chromium/$PdfiumBuild -> $DllTarget (SHA-256: $DllHash)"
} finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
