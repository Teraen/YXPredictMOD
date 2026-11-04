# Repack the last checked game DLL with the current manifest, assets and README.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:DOTNET_CLI_HOME = Join-Path $root '.cache/dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:NUGET_PACKAGES = Join-Path $root '.cache/nuget'
Push-Location -LiteralPath $root
try {
    $stage = Join-Path $root '.cache/package'
    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    & dotnet vendor/yixianpai-mod-sdk/tools/yx-patch.dll pack mod --out $stage
    if ($LASTEXITCODE -ne 0) { throw 'SDK打包失败。' }
    $manifest = Get-Content -LiteralPath 'mod/manifest.json' -Encoding UTF8 -Raw | ConvertFrom-Json
    $stagedPackage = Join-Path $stage ($manifest.id + '-' + $manifest.version + '.zip')
    $package = Join-Path $dist ($manifest.name + '-' + $manifest.version + '.zip')
    # The archive root stays the mod ID so the manager can upgrade existing installs.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($stagedPackage, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        $entryPath = $manifest.id + '/README.md'
        $previous = $zip.GetEntry($entryPath)
        if ($null -ne $previous) { $previous.Delete() }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'mod/README.md'), $entryPath) | Out-Null
    } finally { $zip.Dispose() }
    Move-Item -LiteralPath $stagedPackage -Destination $package -Force
    Write-Output $package
} finally { Pop-Location }
