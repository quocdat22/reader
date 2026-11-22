[CmdletBinding()]
param(
    [string]$Version = "chromium/8125",
    [string]$ExpectedSha256 = "9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$DefaultVersion = "chromium/8125"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $RepoRoot "src-tauri\resources\pdfium"
$TargetDll = Join-Path $TargetDir "pdfium.dll"

if (-not $Force -and (Test-Path -LiteralPath $TargetDll)) {
    $existing = Get-Item -LiteralPath $TargetDll
    if ($existing.Length -gt 0) {
        Write-Host "pdfium.dll already present at $TargetDll ($($existing.Length) bytes). Use -Force to re-download."
        exit 0
    }
}

$DownloadUrl = "https://github.com/bblanchon/pdfium-binaries/releases/download/$Version/pdfium-win-x64.tgz"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("reader-pdfium-" + [System.Guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TempRoot "pdfium-win-x64.tgz"
$ExtractDir = Join-Path $TempRoot "extract"

try {
    New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null

    # Ensure TLS 1.2 is enabled for Windows PowerShell 5.1.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    Write-Host "Downloading PDFium ($Version) from $DownloadUrl ..."
    $PreviousProgressPreference = $ProgressPreference
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing
    }
    finally {
        $ProgressPreference = $PreviousProgressPreference
    }

    if (-not (Test-Path -LiteralPath $ArchivePath) -or (Get-Item -LiteralPath $ArchivePath).Length -eq 0) {
        throw "Downloaded archive is missing or empty: $ArchivePath"
    }

    $ShouldVerifyHash = ($Version -eq $DefaultVersion) -or (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and $PSBoundParameters.ContainsKey("ExpectedSha256"))
    if ($ShouldVerifyHash -and -not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $NormalizedExpected = $ExpectedSha256.Trim().ToLowerInvariant()
        if ($ActualSha256 -ne $NormalizedExpected) {
            throw "SHA-256 mismatch for pdfium-win-x64.tgz. Expected: $NormalizedExpected, Actual: $ActualSha256"
        }
        Write-Host "Verified archive SHA-256: $ActualSha256"
    }

    $TarExe = Get-Command "tar.exe" -ErrorAction SilentlyContinue
    if ($null -eq $TarExe) {
        throw "tar.exe was not found on PATH; cannot extract $ArchivePath"
    }

    Write-Host "Extracting bin/pdfium.dll ..."
    & $TarExe.Source -xzf $ArchivePath -C $ExtractDir "bin/pdfium.dll"
    if ($LASTEXITCODE -ne 0) {
        throw "tar.exe failed to extract bin/pdfium.dll (exit code $LASTEXITCODE)"
    }

    $ExtractedDll = Join-Path $ExtractDir "bin\pdfium.dll"
    if (-not (Test-Path -LiteralPath $ExtractedDll) -or (Get-Item -LiteralPath $ExtractedDll).Length -eq 0) {
        throw "Extracted pdfium.dll is missing or empty: $ExtractedDll"
    }

    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    $StagedDll = Join-Path $TargetDir ("pdfium.dll.tmp." + [System.Guid]::NewGuid().ToString("N"))
    Copy-Item -LiteralPath $ExtractedDll -Destination $StagedDll -Force
    Move-Item -LiteralPath $StagedDll -Destination $TargetDll -Force

    $FinalItem = Get-Item -LiteralPath $TargetDll
    Write-Host "Installed pdfium.dll ($Version) at $TargetDll ($($FinalItem.Length) bytes)."
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
