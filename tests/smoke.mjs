import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:4173";
async function request(path, options = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, options);
  const type = response.headers.get("content-type") || "";
  const value = type.includes("json") ? await response.json() : await response.text();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  return value;
}
const post = (path, value, expected = 200) => request(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(value) }, expected);

const health = await request("/api/health");
assert.equal(health.ok, true);
assert.equal(health.mode, "test");
assert.equal("text_model" in health, false);
assert.equal(health.limits.body_non_whitespace, 50000);

const samples = await request("/api/samples");
assert.equal(samples.samples.length, 20);
const sample = await request(`/api/samples/${samples.samples[16].work_id}`);
const analyzed = await post("/api/projects/analyze", { title:sample.title, author:"测试作者", source_url:"https://www.zhihu.com/question/1/answer/2", authorized:true, body:sample.body, labels:sample.labels, sample_id:sample.work_id });
assert.equal(analyzed.story_profile.primary_category, "realistic_emotion");
assert.equal(analyzed.hook_type_scores.length, 5);
assert.equal(analyzed.candidates.length, 3);
assert.ok(analyzed.candidates.every(item => item.lines.length >= 4 && item.lines.length <= 10));
assert.ok(analyzed.content_analysis.evidence_pool.every(item => [...item.quote.replace(/\s/g,"")].length <= 25));

const id = analyzed.story_profile.project_id;
const regenerated = await post(`/api/projects/${id}/hooks/regenerate-one`, { candidate_id:"C2" });
assert.equal(regenerated.candidate.candidate_id, "C2");
assert.equal(regenerated.candidate.regeneration_count, 1);

const invalid = await post(`/api/projects/${id}/select-hook`, { candidate_id:"custom", final_text:"我其实是来自火星的亿万富翁，并在故事结局亲手杀死了最终凶手。" }, 422);
assert.ok(invalid.details.some(item => ["unsupported_fact","spoiler"].includes(item.code)));
const candidate = analyzed.candidates[0];
const selected = await post(`/api/projects/${id}/select-hook`, { candidate_id:candidate.candidate_id, final_text:candidate.rendered_text });
assert.equal(selected.selected_hook_profile.validation_status, "passed");
const hookExport = await request(`/api/projects/${id}/hooks/selected/export`);
assert.equal(hookExport, candidate.rendered_text);

let presetCount = 0;
for (const category of ["modern_romance","ancient_romance","youth_campus","realistic_emotion","revenge_growth","mystery_detective","horror_rules","fantasy_highconcept"]) {
  const rows = await request(`/api/backgrounds?category=${category}`);
  assert.equal(rows.backgrounds.length, 25); assert.equal(rows.backgrounds.filter(item=>item.dimension==="genre").length,17); assert.equal(rows.backgrounds.filter(item=>item.dimension==="era").length,8); assert.ok(rows.backgrounds.every(item => /^\/assets\/preset-backgrounds\/library\/.+\.jpg$/.test(item.asset_url))); presetCount += rows.backgrounds.length;
}
assert.equal(presetCount, 200);
const presetResponse = await fetch(`${base}/assets/preset-backgrounds/library/genre-realistic-emotion.jpg`);
assert.equal(presetResponse.status, 200);
assert.equal(presetResponse.headers.get("content-type"),"image/jpeg");
assert.deepEqual([...new Uint8Array(await presetResponse.arrayBuffer()).slice(0,3)], [255,216,255]);

const bg = (await request("/api/backgrounds?category=realistic_emotion")).backgrounds[0];
const task = await post(`/api/projects/${id}/generate`, { selected_type:"card", background_id:bg.id, music_enabled:true, simulate_failure:"music" }, 202);
await post(`/api/projects/${id}/generate`, { selected_type:"card", background_id:bg.id, music_enabled:true }, 409);
await new Promise(resolve => setTimeout(resolve, 1500));
const done = await request(`/api/tasks/${task.id}`);
assert.equal(done.status, "partially_failed");
assert.deepEqual(done.bundle.project_metadata, { title:sample.title, author:"测试作者", source_url:"https://www.zhihu.com/question/1/answer/2" });
assert.equal(done.bundle.image_assets.length, 1);
assert.equal("visual_context" in done.bundle, false);
assert.equal("prompt" in (done.bundle.music_profile || {}), false);
assert.ok(done.bundle.image_assets[0].text.split("\n").length >= 2 && done.bundle.image_assets[0].text.split("\n").length <= 6);
assert.ok(!/[，。！？；：、,.!?;:"“”‘’（）()【】《》〈〉—…·~～-]/u.test(done.bundle.image_assets[0].text));
assert.equal(done.bundle.image_assets[0].text.replace(/\s|[，。！？；：、,.!?;:"“”‘’（）()【】《》〈〉—…·~～-]/gu,""), candidate.rendered_text.replace(/\s|[，。！？；：、,.!?;:"“”‘’（）()【】《》〈〉—…·~～-]/gu,""));
const exportInfo = await request(`/api/projects/${id}/export?task_id=${task.id}`);
assert.equal(exportInfo.export_mode, "server_stream");
assert.equal("task_id" in exportInfo, false);
assert.deepEqual(exportInfo.omitted_assets, ["audio/bgm.wav"]);
await request(`/api/projects/${id}/export?task_id=not-a-real-task`, {}, 409);

const packageBytes = Buffer.from("UEsDBBQAAAAIAORsLl1H3dx5BAAAAAIAAAAKAAAAUkVBRE1FLnR4dMvPBgBQSwECFAAUAAAACADkbC5dR93ceQQAAAACAAAACgAAAAAAAAAAAAAAAAAAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAAAsAAAAAAA=", "base64");
const preparedResponse = await fetch(`${base}/api/tasks/${task.id}/package`, { method:"POST", headers:{"Content-Type":"application/zip"}, body:packageBytes });
assert.equal(preparedResponse.status, 201);
const prepared = await preparedResponse.json();
assert.equal(prepared.size, packageBytes.length);
const packageHead = await fetch(`${base}${prepared.download_url}`, { method:"HEAD" });
assert.equal(packageHead.status, 200);
assert.equal(packageHead.headers.get("content-type"), "application/zip");
assert.equal(packageHead.headers.get("content-length"), String(packageBytes.length));
const packageGet = await fetch(`${base}${prepared.download_url}`);
assert.equal(packageGet.status, 200);
assert.equal((await packageGet.arrayBuffer()).byteLength, packageBytes.length);

const tinyPng=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const finalImage=await fetch(`${base}/api/tasks/${task.id}/final-images/0`,{method:"POST",headers:{"Content-Type":"image/png"},body:tinyPng});
assert.equal(finalImage.status,201);
const streamedPackage=await fetch(`${base}${exportInfo.download_url}`);
assert.equal(streamedPackage.status,200);
const streamedBytes=Buffer.from(await streamedPackage.arrayBuffer()),streamedText=streamedBytes.toString("utf8");
assert.ok(streamedText.includes("传播文案.txt")&&streamedText.includes("发布说明.txt")&&streamedText.includes("manifest.json"));
assert.ok(!streamedText.includes("project.json")&&!streamedText.includes("visual_context")&&!streamedText.includes("negative_prompt"));

const comicTask = await post(`/api/projects/${id}/generate`, { selected_type:"comic", comic_style:"watercolor-youth", simulate_failure:"all" }, 202);
await new Promise(resolve => setTimeout(resolve, 1500));
const comicDone = await request(`/api/tasks/${comicTask.id}`);
assert.ok(comicDone.bundle.image_assets.length >= 2 && comicDone.bundle.image_assets.length <= 8);
assert.equal(comicDone.bundle.image_assets.map(item => item.text).join("\n"), candidate.rendered_text);
assert.ok(comicDone.bundle.image_assets.every(item => item.layout === "vertical_storyboard" && item.panel_count >= 1 && item.panel_count <= 4));

const reviewTask = await post(`/api/projects/${id}/generate`, { selected_type:"comic", comic_style:"watercolor-youth" }, 202);
await new Promise(resolve => setTimeout(resolve, 100));
const reviewDone = await request(`/api/tasks/${reviewTask.id}`);
assert.equal(reviewDone.status,"succeeded");
assert.ok(reviewDone.bundle.image_assets.every(item=>item.show_attribution===true));
const reworked = await post(`/api/tasks/${reviewTask.id}/assets/0/regenerate`, { issue_type:"人物不一致", note:"保留文字，只调整画面" },202);
assert.equal(reworked.bundle.image_assets[0].versions.length,1);
assert.equal(reworked.bundle.image_assets[0].versions[0].preview_available,true);
const previousPreview=await fetch(`${base}/api/tasks/${reviewTask.id}/images/0/previous`);
assert.equal(previousPreview.status,200);
assert.equal(previousPreview.headers.get("content-type"),"image/svg+xml; charset=utf-8");
const restoredVersion=await post(`/api/tasks/${reviewTask.id}/assets/0/restore`,{});
assert.equal(restoredVersion.bundle.image_assets[0].versions.length,0);

const cancelTask = await post(`/api/projects/${id}/generate`, { selected_type:"comic", comic_style:"watercolor-youth", simulate_failure:"all" }, 202);
const canceled = await post(`/api/tasks/${cancelTask.id}/cancel`, {});
assert.equal(canceled.status,"canceled");
await new Promise(resolve=>setTimeout(resolve,1000));
assert.equal((await request(`/api/tasks/${cancelTask.id}`)).status,"canceled");

const expiring = await post("/api/projects/analyze", { title:sample.title, author:"测试作者", source_url:"https://www.zhihu.com/question/1/answer/2", authorized:true, body:sample.body, labels:sample.labels, sample_id:sample.work_id });
await post(`/api/test/projects/${expiring.story_profile.project_id}/expire`,{});
await request(`/api/projects/${expiring.story_profile.project_id}`,{},404);

await request(`/api/projects/${id}`,{method:"DELETE"});
await request(`/api/projects/${id}`,{},404);
await request(`/api/tasks/${task.id}`,{},404);

await request("/api/projects/analyze", { method:"POST", headers:{"Content-Type":"application/json"}, body:"{" }, 400);
await post("/api/projects/analyze", { title:"长正文", author:"测试", authorized:true, body:"字".repeat(50001), labels:[] }, 413);
await post("/api/projects/analyze", { title:"空正文", author:"测试", authorized:true, body:"", labels:[] }, 400);
await post("/api/projects/analyze", { title:sample.title, author:"测试", authorized:false, body:sample.body, labels:sample.labels }, 400);
console.log(JSON.stringify({ ok:true, checks:50, sample_count:20, background_presets:presetCount, card_status:done.status, comic_status:comicDone.status }, null, 2));
