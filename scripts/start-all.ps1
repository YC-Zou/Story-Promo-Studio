$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$audioDir = Join-Path $root "third_party\stable-audio-3-tflite"
$runtimeDir = Join-Path $root ".runtime"
$logDir = Join-Path $runtimeDir "logs"
$pidFile = Join-Path $runtimeDir "processes.json"
$appUrl = "http://127.0.0.1:4173"
$audioUrl = "http://127.0.0.1:7871"

foreach ($name in @("OPENAI_NEXT_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "SEEDREAM_BASE_URL", "HOOK_MODEL", "SEEDREAM_MODEL", "APP_MODE")) {
  if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
    $saved = [Environment]::GetEnvironmentVariable($name, "User")
    if ($saved) { [Environment]::SetEnvironmentVariable($name, $saved, "Process") }
  }
}
if (-not $env:OPENAI_API_KEY -and $env:OPENAI_NEXT_API_KEY) { $env:OPENAI_API_KEY = $env:OPENAI_NEXT_API_KEY }
$env:APP_MODE = if ($env:APP_MODE) { $env:APP_MODE } elseif ($env:OPENAI_API_KEY) { "live" } else { "demo" }

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-Step([string]$message) {
  Write-Host "`n> $message" -ForegroundColor Cyan
}

function Test-Url([string]$url) {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-Url([string]$url, [int]$seconds, [string]$name) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $url) { return }
    Start-Sleep -Milliseconds 750
  }
  throw "$name did not become ready within $seconds seconds. Check .runtime\logs."
}

Write-Step "Checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js was not found. Install Node.js 20 or newer from https://nodejs.org/"
}
$nodeVersion = (& node --version).TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required. Found $nodeVersion."
}
Write-Host "  Node.js $nodeVersion" -ForegroundColor Green

$audioProcess = $null
if ($env:APP_MODE -eq "demo") {
  Write-Host "  Demo mode: Stable Audio setup is skipped." -ForegroundColor Yellow
} elseif (Test-Url "$audioUrl/gradio_api/info") {
  Write-Host "  Stable Audio is already available at $audioUrl" -ForegroundColor Green
} else {
  Write-Step "Preparing Stable Audio 3"
  $env:HF_HOME = Join-Path $audioDir ".cache\huggingface"
  Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
  $env:NO_PROXY = "127.0.0.1,localhost"
  $env:no_proxy = "127.0.0.1,localhost"
  $env:GRADIO_ANALYTICS_ENABLED = "False"

  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pythonCommand) {
    throw "Python 3.10-3.13 x64 was not found. Install it from https://www.python.org/downloads/ and add it to PATH."
  }
  $pythonVersionText = (& python -c "import platform,sys; print(f'{sys.version_info.major}.{sys.version_info.minor}|{platform.architecture()[0]}')").Trim()
  $pythonParts = $pythonVersionText.Split("|")
  $pythonVersion = [version]$pythonParts[0]
  if ($pythonVersion.Major -ne 3 -or $pythonVersion.Minor -lt 10 -or $pythonVersion.Minor -gt 13 -or $pythonParts[1] -ne "64bit") {
    throw "Stable Audio requires Python 3.10-3.13 x64. Found $pythonVersionText."
  }
  Write-Host "  Python $pythonVersionText" -ForegroundColor Green

  $audioPython = Join-Path $audioDir ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $audioPython)) {
    Write-Host "  First run: installing Python packages and downloading the Small Music model (~2.5 GB)." -ForegroundColor Yellow
    Push-Location $audioDir
    try {
      & cmd.exe /d /c "install.bat --download sm-music"
      if ($LASTEXITCODE -ne 0) { throw "Stable Audio installation failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
  }

  & $audioPython -c "import gradio, PIL, soundfile" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Installing Stable Audio web-service dependencies..." -ForegroundColor Yellow
    & $audioPython -m pip install -r (Join-Path $audioDir "requirements-gradio.txt")
    if ($LASTEXITCODE -ne 0) { throw "Stable Audio web dependencies could not be installed." }
  }

  $audioOut = Join-Path $logDir "stable-audio.out.log"
  $audioErr = Join-Path $logDir "stable-audio.err.log"
  $audioArgs = @(
    ('"' + (Join-Path $audioDir "scripts\sa3_gradio.py") + '"'),
    "--dit", "sm-music",
    "--decoder", "same-s",
    "--precision", "fp32",
    "--default-seconds", "20",
    "--default-steps", "8",
    "--threads", "10",
    "--port", "7871",
    "--no-share"
  )
  $audioProcess = Start-Process -FilePath $audioPython -ArgumentList $audioArgs -WorkingDirectory $audioDir -WindowStyle Hidden -RedirectStandardOutput $audioOut -RedirectStandardError $audioErr -PassThru
  Write-Host "  Starting Stable Audio (PID $($audioProcess.Id))..."
  Wait-Url "$audioUrl/gradio_api/info" 180 "Stable Audio"
  Write-Host "  Stable Audio is ready" -ForegroundColor Green
}

foreach ($name in @("OPENAI_NEXT_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "SEEDREAM_BASE_URL", "HOOK_MODEL", "SEEDREAM_MODEL")) {
  if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
    $saved = [Environment]::GetEnvironmentVariable($name, "User")
    if ($saved) { [Environment]::SetEnvironmentVariable($name, $saved, "Process") }
  }
}
if (-not $env:OPENAI_API_KEY -and $env:OPENAI_NEXT_API_KEY) { $env:OPENAI_API_KEY = $env:OPENAI_NEXT_API_KEY }
$env:OPENAI_BASE_URL = if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { "https://api.openai-next.com/v1" }
$env:SEEDREAM_BASE_URL = if ($env:SEEDREAM_BASE_URL) { $env:SEEDREAM_BASE_URL } else { $env:OPENAI_BASE_URL }
$env:HOOK_MODEL = if ($env:HOOK_MODEL) { $env:HOOK_MODEL } else { "gpt-5.6-sol" }
$env:SEEDREAM_MODEL = if ($env:SEEDREAM_MODEL) { $env:SEEDREAM_MODEL } else { "doubao-seedream-5-0-pro-260628" }
$env:MUSIC_BASE_URL = $audioUrl
$env:PORT = "4173"

if (-not $env:OPENAI_API_KEY) {
  Write-Warning "No API key is configured. Run '首次配置 API Key.cmd'; the UI can open, but model generation will be unavailable."
}

$appProcess = $null
if (Test-Url "$appUrl/api/health") {
  Write-Host "  The application is already available at $appUrl" -ForegroundColor Green
} else {
  Write-Step "Starting Zhihu Story Promo Studio"
  $appOut = Join-Path $logDir "app.out.log"
  $appErr = Join-Path $logDir "app.err.log"
  $serverPath = '"' + (Join-Path $root "server.mjs") + '"'
  $appProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList $serverPath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $appOut -RedirectStandardError $appErr -PassThru
  Wait-Url "$appUrl/api/health" 30 "Application"
  Write-Host "  Application is ready (PID $($appProcess.Id))" -ForegroundColor Green
}

@{
  root = $root
  startedAt = (Get-Date).ToString("o")
  appPid = if ($appProcess) { $appProcess.Id } else { $null }
  audioPid = if ($audioProcess) { $audioProcess.Id } else { $null }
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

Write-Host "`nOpening $appUrl" -ForegroundColor Green
Start-Process $appUrl
Write-Host "Use '停止.cmd' to stop services started by this launcher."
