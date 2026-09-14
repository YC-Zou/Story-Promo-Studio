$ErrorActionPreference = "Stop"

# Import user-scoped credentials into this child process without printing or
# persisting them. This matters when the desktop app predates the saved key.
if (-not $env:OPENAI_NEXT_API_KEY) {
  $env:OPENAI_NEXT_API_KEY = [Environment]::GetEnvironmentVariable("OPENAI_NEXT_API_KEY", "User")
}
if (-not $env:OPENAI_API_KEY) {
  $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User")
}
if (-not $env:OPENAI_API_KEY -and $env:OPENAI_NEXT_API_KEY) {
  $env:OPENAI_API_KEY = $env:OPENAI_NEXT_API_KEY
}

$env:OPENAI_BASE_URL = if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { "https://api.openai-next.com/v1" }
$env:SEEDREAM_BASE_URL = if ($env:SEEDREAM_BASE_URL) { $env:SEEDREAM_BASE_URL } else { $env:OPENAI_BASE_URL }
$env:HOOK_MODEL = if ($env:HOOK_MODEL) { $env:HOOK_MODEL } else { "gpt-5.6-sol" }
$env:SEEDREAM_MODEL = if ($env:SEEDREAM_MODEL) { $env:SEEDREAM_MODEL } else { "doubao-seedream-5-0-pro-260628" }
$env:MUSIC_BASE_URL = if ($env:MUSIC_BASE_URL) { $env:MUSIC_BASE_URL } else { "http://127.0.0.1:7871" }

if (-not $env:OPENAI_API_KEY) {
  Write-Warning "No server-side API key found. Hook and Seedream generation will report UNCONFIGURED instead of returning mock output."
}

node (Join-Path $PSScriptRoot "server.mjs")
