$ErrorActionPreference = "Stop"
$base = if ($env:WORKBENCH_BASE_URL) { $env:WORKBENCH_BASE_URL } else { "http://127.0.0.1:4173" }
$outDir = "work/live-continuity-media"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$list = Invoke-RestMethod "$base/api/samples"
$sample = Invoke-RestMethod "$base/api/samples/$($list.samples[0].work_id)"
$payload = @{ title=$sample.title; author="官方测试作者"; source_url="https://www.zhihu.com/question/1/answer/1"; labels=$sample.labels; body=$sample.body; authorized=$true } | ConvertTo-Json -Depth 8
$analysis = Invoke-RestMethod "$base/api/projects/analyze" -Method Post -ContentType "application/json; charset=utf-8" -Body $payload -TimeoutSec 600
if ($analysis.adapter_mode -ne "live_model" -or $analysis.candidates.Count -ne 3) { throw "Live hook generation failed" }

$shortHook = (($analysis.content_analysis.evidence_pool | Select-Object -First 4).quote -join "`n")
$selected = Invoke-RestMethod "$base/api/projects/$($analysis.story_profile.project_id)/select-hook" -Method Post -ContentType "application/json; charset=utf-8" -Body (@{candidate_id="custom";final_text=$shortHook}|ConvertTo-Json)
if ($selected.selected_hook_profile.validation_status -ne "passed") { throw "Evidence hook validation failed" }

$task = Invoke-RestMethod "$base/api/projects/$($analysis.story_profile.project_id)/generate" -Method Post -ContentType "application/json" -Body (@{selected_type="comic"}|ConvertTo-Json) -TimeoutSec 600
$deadline = (Get-Date).AddMinutes(12)
do {
  Start-Sleep -Seconds 3
  $task = Invoke-RestMethod "$base/api/tasks/$($task.id)"
  Write-Host ("TASK {0}% {1}" -f $task.progress,$task.status)
  if ((Get-Date) -gt $deadline) { throw "Task timed out" }
} while ($task.status -in @("queued","running"))

if ($task.status -eq "partially_failed" -and ($task.subtasks | Where-Object id -eq "material").status -eq "succeeded") {
  $task = Invoke-RestMethod "$base/api/tasks/$($task.id)/retry" -Method Post -ContentType "application/json" -Body "{}"
  do {
    Start-Sleep -Seconds 3
    $task = Invoke-RestMethod "$base/api/tasks/$($task.id)"
    Write-Host ("RETRY {0}% {1}" -f $task.progress,$task.status)
    if ((Get-Date) -gt $deadline) { throw "Retry timed out" }
  } while ($task.status -in @("queued","running"))
}

for ($i=0; $i -lt $task.bundle.image_assets.Count; $i++) {
  Invoke-WebRequest "$base/api/tasks/$($task.id)/images/$i" -OutFile (Join-Path $outDir ("comic-{0:d2}.png" -f ($i+1)))
}
if ($task.bundle.audio_url) { Invoke-WebRequest ("$base"+$task.bundle.audio_url) -OutFile (Join-Path $outDir "bgm.wav") }
$report = [ordered]@{ generated_at=(Get-Date).ToString("o"); adapter_mode=$analysis.adapter_mode; candidate_count=$analysis.candidates.Count; selected_hook=$shortHook; task=$task }
$report | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $outDir "report.json") -Encoding utf8
[pscustomobject]@{status=$task.status;pages=$task.bundle.image_assets.Count;page_success=($task.bundle.image_assets|Where-Object status -eq "succeeded").Count;music=($task.subtasks|Where-Object id -eq "music").status;visual_bible_characters=$task.bundle.visual_context.character_bible.characters.Count;audio_bytes=if(Test-Path (Join-Path $outDir "bgm.wav")){(Get-Item (Join-Path $outDir "bgm.wav")).Length}else{0}} | ConvertTo-Json
if ($task.status -ne "succeeded") { exit 1 }
