param([switch]$CoreOnly, [switch]$Demo)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:DOTNET_CLI_HOME = Join-Path $root '.cache/dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$env:NUGET_PACKAGES = Join-Path $root '.cache/nuget'
function Invoke-Dotnet {
    & dotnet @args
    if ($LASTEXITCODE -ne 0) { throw ('dotnet执行失败，退出码：' + $LASTEXITCODE) }
}
Push-Location -LiteralPath $root
try {
    if (!(Test-Path -LiteralPath 'vendor/yixianpai-mod-sdk/sdk/net40/Yx.ModSdk.Core.dll')) { throw '先运行 scripts/restore-sdk.ps1。' }
    Invoke-Dotnet restore tests/PredictionChecks.csproj --configfile NuGet.Config
    Invoke-Dotnet run --project tests/PredictionChecks.csproj --no-restore
    Invoke-Dotnet run --project tests/PredictionChecks.csproj --no-build -- --rule-parity .cache/single-player-parity.json
    $parityHash = (Get-FileHash '.cache/single-player-parity.json').Hash
    if ($parityHash -ne (Get-FileHash 'server/fixtures/single-player-parity.json').Hash) { throw '单人规则对照数据发生变化，请重新生成并审核服务端对照测试。' }
    & node --test server/rooms.test.mjs server/rules.test.mjs
    if ($LASTEXITCODE -ne 0) { throw '联机规则对照失败。' }
    Invoke-Dotnet run --project tests/GameEntryChecks/GameEntryChecks.csproj
    Invoke-Dotnet run --project tests/HorseHoverChecks/HorseHoverChecks.csproj
    Invoke-Dotnet run --project tests/NativeTalentChecks/NativeTalentChecks.csproj
    Invoke-Dotnet run --project tests/RoomClientChecks/RoomClientChecks.csproj
    Invoke-Dotnet run --project tests/EloClientChecks/EloClientChecks.csproj
    & (Join-Path $PSScriptRoot 'check-interpreter.ps1')
    if ($Demo) { Invoke-Dotnet run --project tests/PredictionChecks.csproj --no-build -- --demo }
    if (!$CoreOnly -and !(Test-Path -LiteralPath 'refs/UnityEngine.UnityWebRequestModule.dll')) { throw '完整游戏版需要先运行 scripts/prepare-game.ps1。纯逻辑验证可用 -CoreOnly。' }
    Invoke-Dotnet restore mod/PredictionPoints.csproj --configfile NuGet.Config
    if ($CoreOnly) { Invoke-Dotnet build mod/PredictionPoints.csproj -c Release --no-restore '-p:CoreOnly=true' }
    else { Invoke-Dotnet build mod/PredictionPoints.csproj -c Release --no-restore }
    Invoke-Dotnet vendor/yixianpai-mod-sdk/tools/yx-patch.dll check --warn-as-error --manifest mod/manifest.json mod/plugins/PredictionPoints.dll
    if (!$CoreOnly) { Invoke-Dotnet run --project tests/RoomClientChecks/RoomClientChecks.csproj --no-build -- (Join-Path $root 'mod/plugins/PredictionPoints.dll') }
    if (!$CoreOnly) { & (Join-Path $PSScriptRoot 'package.ps1') }
} finally { Pop-Location }
