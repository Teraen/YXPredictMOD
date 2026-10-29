param(
    [string]$GamePath = 'C:\Program Files (x86)\Steam\steamapps\common\YiXianPai',
    [string]$DumperPath = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$patcher = Join-Path $root 'vendor/yixianpai-mod-sdk/tools/yx-patch.dll'
if (!(Test-Path -LiteralPath $patcher)) { throw '先运行 scripts/restore-sdk.ps1。' }
$assembly = Join-Path $GamePath 'GameAssembly.dll'
$metadata = Join-Path $GamePath 'YiXianPai_Data/il2cpp_data/Metadata/global-metadata.dat'
if (!(Test-Path -LiteralPath $assembly) -or !(Test-Path -LiteralPath $metadata)) { throw '游戏目录无效。' }
if (!$DumperPath) {
    $cache = Join-Path $root '.cache/Il2CppDumper'
    $archive = Join-Path $cache 'release.zip'
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    if (!(Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri 'https://github.com/Perfare/Il2CppDumper/releases/download/v6.7.46/Il2CppDumper-net6-win-v6.7.46.zip' -OutFile $archive -TimeoutSec 60
    }
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($hash -ne 'D1117D66B9F8A130FD4933AE99F8EB9A0ECBBDB79D1FC494EB738AD910FF765A') { throw 'Il2CppDumper发行包哈希不符。' }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $cache 'bin') -Force
    $DumperPath = Join-Path $cache 'bin/Il2CppDumper.exe'
}
# 在项目缓存里运行副本，只写项目内配置和引用；不修改游戏及用户提供的工具目录。
$runner = Join-Path $root '.cache/dumper-runner'
New-Item -ItemType Directory -Path $runner -Force | Out-Null
$resolvedDumper = (Resolve-Path -LiteralPath $DumperPath).Path
Copy-Item -Path (Join-Path (Split-Path -Parent $resolvedDumper) '*') -Destination $runner -Force
$configPath = Join-Path $runner 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config.RequireAnyKey = $false
$config.GenerateStruct = $false
$config.DumpMethod = $false
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$dump = Join-Path $root '.cache/game-dump'
New-Item -ItemType Directory -Path $dump -Force | Out-Null
& (Join-Path $runner (Split-Path -Leaf $resolvedDumper)) $assembly $metadata $dump
if ($LASTEXITCODE -ne 0) { throw 'Il2CppDumper失败。' }
& dotnet $patcher refs --game $GamePath --out (Join-Path $root 'refs') --dump-dir (Join-Path $dump 'DummyDll')
if ($LASTEXITCODE -ne 0) { throw 'SDK引用提取失败。' }
Copy-Item -LiteralPath (Join-Path $dump 'DummyDll/UnityEngine.UnityWebRequestModule.dll') -Destination (Join-Path $root 'refs/UnityEngine.UnityWebRequestModule.dll') -Force
Copy-Item -LiteralPath (Join-Path $dump 'DummyDll/UnityEngine.ImageConversionModule.dll') -Destination (Join-Path $root 'refs/UnityEngine.ImageConversionModule.dll') -Force
Copy-Item -LiteralPath (Join-Path $dump 'DummyDll/UnityEngine.IMGUIModule.dll') -Destination (Join-Path $root 'refs/UnityEngine.IMGUIModule.dll') -Force
Copy-Item -LiteralPath (Join-Path $dump 'DummyDll/LucidSight.Runtime.ColyseusSDK.dll') -Destination (Join-Path $root 'refs/LucidSight.Runtime.ColyseusSDK.dll') -Force
Write-Output '游戏引用已更新；refs/ 属于本机游戏，不应分发或提交。'
