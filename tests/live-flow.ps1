$ErrorActionPreference = "Stop"
$base = if ($env:WORKBENCH_BASE_URL) { $env:WORKBENCH_BASE_URL } else { "http://127.0.0.1:4173" }

$list = Invoke-RestMethod "$base/api/samples"
if (-not $list.samples -or $list.samples.Count -lt 1) { throw "No benchmark samples" }
$sample = Invoke-RestMethod "$base/api/samples/$($list.samples[0].work_id)"
$inputBody = @{
  title = $sample.title
  author = "官方测试作者"
  source_url = "https://www.zhihu.com/question/1/answer/1"
  labels = $sample.labels
  body = $sample.body
  authorized = $true
} | ConvertTo-Json -Depth 10

$analysis = Invoke-RestMethod "$base/api/projects/analyze" -Method Post -ContentType "application/json; charset=utf-8" -Body $inputBody -TimeoutSec 600
if ($analysis.adapter_mode -ne "live_model") { throw "Hook result is not live_model" }
if ($analysis.candidates.Count -ne 3) { throw "Expected 3 hook candidates" }
$best = $analysis.candidates | Where-Object candidate_id -eq $analysis.best_candidate_id | Select-Object -First 1
if (-not $best) { throw "Best candidate missing" }

$selectionBody = @{ candidate_id=$best.candidate_id; final_text=$best.rendered_text } | ConvertTo-Json
$selection = Invoke-RestMethod "$base/api/projects/$($analysis.story_profile.project_id)/select-hook" -Method Post -ContentType "application/json; charset=utf-8" -Body $selectionBody
if ($selection.selected_hook_profile.validation_status -ne "passed") { throw "Selected hook failed validation" }

$generationBody = @{ selected_type="comic" } | ConvertTo-Json
$task = Invoke-RestMethod "$base/api/projects/$($analysis.story_profile.project_id)/generate" -Method Post -ContentType "application/json" -Body $generationBody
$deadline = (Get-Date).AddMinutes(15)
do {
  Start-Sleep -Seconds 2
  $task = Invoke-RestMethod "$base/api/tasks/$($task.id)"
  Write-Host ("TASK {0}% {1} | {2}" -f $task.progress,$task.status,$task.message)
  if ((Get-Date) -gt $deadline) { throw "Task timed out" }
} while ($task.status -in @("queued","running"))

$health = Invoke-RestMethod "$base/api/health"
$result = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  sample = @{ work_id=$sample.work_id; title=$sample.title; labels=$sample.labels }
  hook = @{ adapter_mode=$analysis.adapter_mode; model=$health.text_model.model; verified=$health.text_model.verified; candidate_count=$analysis.candidates.Count; best_candidate_id=$analysis.best_candidate_id; best_text=$best.rendered_text }
  task = $task
  health = $health
}
$result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath "work/live-flow-result.json" -Encoding utf8
$result | ConvertTo-Json -Depth 8
if ($task.status -ne "succeeded") { exit 1 }
