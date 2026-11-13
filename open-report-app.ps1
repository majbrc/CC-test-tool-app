[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceFile = Join-Path $projectRoot 'app\src\ChargingTestConsole.java'
$sourceDir = Split-Path -Parent $sourceFile
$classesDir = Join-Path $projectRoot 'app\classes'
$classFile = Join-Path $classesDir 'ChargingTestConsole.class'
$runtimeDir = Join-Path $projectRoot 'target\app-runtime'
$serverOut = Join-Path $runtimeDir 'server.out.log'
$serverError = Join-Path $runtimeDir 'server.error.log'
$appUrl = 'http://127.0.0.1:8765'

function Test-AppServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$appUrl/api/state" -TimeoutSec 1
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
    throw "Application source was not found: $sourceFile"
}

New-Item -ItemType Directory -Force -Path $classesDir, $runtimeDir | Out-Null
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceDir -Filter '*.java' -File)

$requiresBuild = -not (Test-Path -LiteralPath $classFile -PathType Leaf)
if (-not $requiresBuild) {
    foreach ($source in $sourceFiles) {
        $compiledFile = Join-Path $classesDir ($source.BaseName + '.class')
        if (-not (Test-Path -LiteralPath $compiledFile -PathType Leaf)) {
            $requiresBuild = $true
            break
        }
        if ($source.LastWriteTimeUtc -gt (Get-Item -LiteralPath $compiledFile).LastWriteTimeUtc) {
            $requiresBuild = $true
            break
        }
    }
}

if ($requiresBuild) {
    & javac.exe -encoding UTF-8 -source 1.8 -target 1.8 -d $classesDir $sourceFiles.FullName
    if ($LASTEXITCODE -ne 0) {
        throw 'The Charging Test Console could not be compiled.'
    }
}

if (-not (Test-AppServer)) {
    Start-Process -FilePath 'java.exe' `
        -ArgumentList @('-cp', "`"$classesDir`"", 'ChargingTestConsole', "`"$projectRoot`"") `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut `
        -RedirectStandardError $serverError

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-AppServer) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        $details = if (Test-Path $serverError) { Get-Content $serverError -Raw } else { 'No server error log was produced.' }
        throw "The Charging Test Console server did not start.`n$details"
    }
}

$browserCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

$browser = $browserCandidates | Select-Object -First 1
if ($browser) {
    Start-Process -FilePath $browser -ArgumentList @("--app=$appUrl", '--start-maximized')
} else {
    Start-Process $appUrl
}
