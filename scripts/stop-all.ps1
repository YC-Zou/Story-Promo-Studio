$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".runtime\processes.json"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "No launcher process record was found. Nothing to stop."
  exit 0
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
foreach ($entry in @(
  @{ Name = "application"; Pid = $record.appPid },
  @{ Name = "Stable Audio"; Pid = $record.audioPid }
)) {
  if (-not $entry.Pid) { continue }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.Pid)" -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Host "$($entry.Name) is already stopped."
    continue
  }
  if (-not $process.CommandLine -or $process.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    Write-Warning "PID $($entry.Pid) no longer belongs to this project; it was not stopped."
    continue
  }
  Stop-Process -Id $entry.Pid -Force
  Write-Host "Stopped $($entry.Name) (PID $($entry.Pid))." -ForegroundColor Green
}

Remove-Item -LiteralPath $pidFile -Force
