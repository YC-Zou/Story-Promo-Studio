$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Write-Host "Zhihu Story Promo Studio - API configuration" -ForegroundColor Cyan
Write-Host "Values are saved to the current Windows user's environment variables, never to this repository."

$secureKey = Read-Host "API Key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "API Key cannot be empty." }

$baseUrl = Read-Host "OpenAI-compatible Base URL [https://api.openai-next.com/v1]"
if ([string]::IsNullOrWhiteSpace($baseUrl)) { $baseUrl = "https://api.openai-next.com/v1" }
$hookModel = Read-Host "Text model [gpt-5.6-sol]"
if ([string]::IsNullOrWhiteSpace($hookModel)) { $hookModel = "gpt-5.6-sol" }
$imageModel = Read-Host "Image model [doubao-seedream-5-0-pro-260628]"
if ([string]::IsNullOrWhiteSpace($imageModel)) { $imageModel = "doubao-seedream-5-0-pro-260628" }

[Environment]::SetEnvironmentVariable("OPENAI_NEXT_API_KEY", $apiKey, "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $apiKey, "User")
[Environment]::SetEnvironmentVariable("OPENAI_BASE_URL", $baseUrl.TrimEnd("/"), "User")
[Environment]::SetEnvironmentVariable("SEEDREAM_BASE_URL", $baseUrl.TrimEnd("/"), "User")
[Environment]::SetEnvironmentVariable("HOOK_MODEL", $hookModel, "User")
[Environment]::SetEnvironmentVariable("SEEDREAM_MODEL", $imageModel, "User")

Write-Host "`nConfiguration saved. You can now double-click '启动.cmd'." -ForegroundColor Green
