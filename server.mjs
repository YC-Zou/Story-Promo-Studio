import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const appMode = process.env.APP_MODE || (process.env.NODE_ENV === "test" ? "test" : (process.env.OPENAI_API_KEY || process.env.OPENAI_NEXT_API_KEY) ? "live" : "demo");
if (!["demo", "live", "test"].includes(appMode)) throw new Error("APP_MODE 必须是 demo、live 或 test");
const isTestMode = appMode === "test";
const isDemoMode = appMode === "demo" || isTestMode;
const retentionMs = Math.max(60_000, Number(process.env.DATA_RETENTION_HOURS || 24) * 60 * 60 * 1000);
const textApiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_NEXT_API_KEY || "";
const imageApiKey = process.env.OPENAI_NEXT_API_KEY || process.env.OPENAI_API_KEY || "";
const textBaseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai-next.com/v1").replace(/\/$/, "");
const imageBaseUrl = (process.env.SEEDREAM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai-next.com/v1").replace(/\/$/, "");
const hookModel = process.env.HOOK_MODEL || "gpt-5.6-sol";
const imageModel = process.env.SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628";
const musicBaseUrl = (process.env.MUSIC_BASE_URL || "http://127.0.0.1:7871").replace(/\/$/, "");
const benchmarkPath = process.env.BENCHMARK_PATH || resolve(root, "data", "samples.jsonl");
const runtimeDir = process.env.RUNTIME_DIR ? resolve(process.env.RUNTIME_DIR) : resolve(root, "work", "runtime");
const mediaDir = resolve(runtimeDir, "media");
const statePath = resolve(runtimeDir, "state.json");
const projects = new Map();
const tasks = new Map();
const taskControllers = new Map();
let persistQueue = Promise.resolve();
let samplesCache = null;
const upstreamState = {
  text: { configured: Boolean(textApiKey), verified: false, last_error: null },
  image: { configured: Boolean(imageApiKey), verified: false, last_error: null },
};

function persistedValue(key, value) {
  if (key === "_image_buffer" || key === "_audio_buffer" || key === "_image_source_url") return undefined;
  return value;
}
function persistState() {
  const snapshot = JSON.stringify({ version:1, saved_at:new Date().toISOString(), projects:[...projects], tasks:[...tasks] }, persistedValue, 2);
  persistQueue = persistQueue.then(async () => {
    await mkdir(runtimeDir, { recursive:true });
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, snapshot, "utf8");
    await rename(temporary, statePath);
  }).catch(err => console.error(`状态保存失败：${err.message}`));
  return persistQueue;
}
async function restoreState() {
  await mkdir(mediaDir, { recursive:true });
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    const now = Date.now();
    for (const [id, project] of saved.projects || []) if (!project.expires_at || project.expires_at > now) projects.set(id, project);
    for (const [id, task] of saved.tasks || []) {
      if ((task.expires_at && task.expires_at <= now) || !projects.has(task.project_id)) { await rm(resolve(mediaDir, id), { recursive:true, force:true }); continue; }
      let interrupted = false;
      for (const subtask of task.subtasks || []) if (["queued","running"].includes(subtask.status)) {
        subtask.status = "failed";
        subtask.message = "服务重启时任务尚未完成，可点击重试继续";
        interrupted = true;
      }
      for (const asset of task.bundle?.image_assets || []) if (["queued","running"].includes(asset.status)) asset.status = "failed";
      if (interrupted || ["queued","running"].includes(task.status)) {
        const material = task.subtasks?.find(item => item.id === "material");
        task.status = material?.status === "failed" ? "failed" : "partially_failed";
        task.progress = 100;
        task.message = "任务被服务重启中断；已完成文件已保留，其余项目可重试";
        task.updated_at = Date.now();
      }
      tasks.set(id, task);
    }
    if ((saved.projects?.length || 0) + (saved.tasks?.length || 0)) console.log(`Restored ${projects.size} projects and ${tasks.size} tasks`);
    if ([...tasks.values()].some(task => /服务重启/.test(task.message || ""))) await persistState();
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`状态恢复失败：${err.message}`);
  }
}
async function deleteProject(projectId) {
  const project = projects.get(projectId);
  if (!project) return false;
  const taskIds = [...new Set(project.bundles || [])];
  for (const taskId of taskIds) {
    taskControllers.get(taskId)?.abort();
    taskControllers.delete(taskId);
    tasks.delete(taskId);
    await rm(resolve(mediaDir, taskId), { recursive:true, force:true });
  }
  projects.delete(projectId);
  await persistState();
  return true;
}
async function cleanupExpired() {
  const now = Date.now();
  for (const [projectId, project] of [...projects]) if (project.expires_at && project.expires_at <= now) await deleteProject(projectId);
  for (const [taskId, task] of [...tasks]) if (task.expires_at && task.expires_at <= now) {
    taskControllers.get(taskId)?.abort(); taskControllers.delete(taskId); tasks.delete(taskId);
    await rm(resolve(mediaDir, taskId), { recursive:true, force:true });
  }
  await persistState();
}
async function saveMedia(taskId, fileName, buffer) {
  const directory = resolve(mediaDir, taskId);
  await mkdir(directory, { recursive:true });
  const filePath = resolve(directory, fileName);
  await writeFile(filePath, buffer);
  return filePath;
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".md": "text/markdown; charset=utf-8" };
const TYPE_LABELS = { relationship_tension: "关系张力型", abnormal_setting: "异常设定型", identity_contrast: "身份反差型", crisis_choice: "危机选择型", emotional_scene: "情绪名场面型" };
const CATEGORIES = {
  modern_romance: ["现代言情", ["#263a58", "#a76872"], ["雨夜城市玻璃", "暖色室内剪影", "夜景街道与双人远影"]],
  ancient_romance: ["古风言情", ["#3f2637", "#a67a5b"], ["月下庭院", "宫墙长廊", "帘幕后的人物剪影"]],
  youth_campus: ["青春校园", ["#315a72", "#d29c72"], ["黄昏教室", "校园林荫道", "雨天教学楼窗边"]],
  realistic_emotion: ["现实情感", ["#293841", "#78898a"], ["冷色城市楼群", "安静餐桌", "空房间与窗光"]],
  revenge_growth: ["复仇逆袭", ["#171d2a", "#8d2830"], ["冷色高楼与红色点光", "暗调办公室", "长廊尽头的人物背影"]],
  mystery_detective: ["悬疑推理", ["#152128", "#5b6669"], ["雾中街巷", "桌面线索与灯光", "半开的门与暗室"]],
  horror_rules: ["惊悚怪谈", ["#10151b", "#572629"], ["空医院走廊", "老旧楼梯间", "红灯下的封闭房门"]],
  fantasy_highconcept: ["脑洞幻想", ["#19284b", "#67538e"], ["城市上空异象", "发光门与人物剪影", "悬浮书页或规则文本空间"]],
};

function sendJson(res, statusCode, value) { res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
function error(message, statusCode = 400, details) { return Object.assign(new Error(message), { statusCode, details }); }
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw error("请求正文超过 4 MB", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw error("请求内容不是合法 JSON"); }
}
async function readBinary(req, maxBytes = 32 * 1024 * 1024) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw error("上传文件超过 32 MB",413);chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function nonWhitespaceLength(text) { return String(text || "").replace(/\s/g, "").length; }
function truncateNonWhitespace(text, limit) {
  let output = "", count = 0;
  for (const char of String(text || "")) {
    if (!/\s/u.test(char)) {
      if (count >= limit) break;
      count += 1;
    }
    output += char;
  }
  return output.trim();
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function round(value) { return Math.round(value * 10) / 10; }
function renderLines(lines) { return lines.map(line => ["dialogue"].includes(line.type) ? `「${line.text}」` : ["message", "system"].includes(line.type) ? `【${line.text}】` : line.text).join("\n"); }
function renderSelectedLine(line) { return line.type === "dialogue" ? `「${line.text}」` : ["message","system"].includes(line.type) ? `【${line.text}】` : line.text; }
function stripPosterPunctuation(text) { return String(text || "").replace(/[，。！？；：、,.!?;:"“”‘’（）()【】《》〈〉—…·~～\-]/gu, "").trim(); }
function splitPreservingText(text) {
  const value = String(text || "");
  const parts = value.match(/[^。！？!?；;，,：:\n]+[。！？!?；;，,：:]?|\n+/g) || [value];
  return parts.filter(part => part && !/^\n+$/.test(part));
}
function groupSelectedLines(selectedLines, maxGroups = 6) {
  let parts = selectedLines.flatMap(line => splitPreservingText(renderSelectedLine(line)));
  if (!parts.length) return [];
  while (parts.length > maxGroups) {
    let best = 0;
    for (let i = 1; i < parts.length - 1; i++) if (nonWhitespaceLength(parts[i]) + nonWhitespaceLength(parts[i + 1]) < nonWhitespaceLength(parts[best]) + nonWhitespaceLength(parts[best + 1])) best = i;
    parts.splice(best, 2, `${parts[best]}${parts[best + 1]}`);
  }
  if (parts.length === 1 && nonWhitespaceLength(parts[0]) >= 2) {
    const chars = [...parts[0]], cut = Math.ceil(chars.length / 2);
    parts = [chars.slice(0, cut).join(""), chars.slice(cut).join("")];
  }
  return parts.map(text => text.trim()).filter(Boolean);
}

async function loadSamples() {
  if (samplesCache) return samplesCache;
  try {
    const text = await readFile(benchmarkPath, "utf8");
    samplesCache = text.split(/\r?\n/).filter(Boolean).map((line, index) => ({ ...JSON.parse(line), data_no: index + 1 }));
  } catch { samplesCache = []; }
  return samplesCache;
}
function sampleAllowedForDemo(sample){return sample?.public_demo_allowed===true&&sample?.redistribution_allowed===true&&Array.isArray(sample.allowed_usage)&&sample.allowed_usage.includes("hackathon_demo")&&(!sample.expires_at||Date.parse(sample.expires_at)>Date.now());}

function inferCategory(title, labels, body) {
  const text = `${title} ${(labels || []).join(" ")} ${body.slice(0, 3000)}`;
  const explicitLabels = new Set((labels || []).map(value => String(value).trim()));
  if (explicitLabels.has("现实情感") || explicitLabels.has("家庭")) return "realistic_emotion";
  if (explicitLabels.has("青春校园") || explicitLabels.has("校园")) return "youth_campus";
  if ((explicitLabels.has("复仇") || explicitLabels.has("逆袭") || explicitLabels.has("爽文")) && (explicitLabels.has("重生") || /复仇|逆袭|翻盘|打脸/.test(text))) return "revenge_growth";
  if (explicitLabels.has("脑洞") && /穿越|修仙|系统|规则|异世界/.test(text) && !explicitLabels.has("惊悚")) return "fantasy_highconcept";
  if (explicitLabels.has("古风言情") || (explicitLabels.has("言情") && (explicitLabels.has("古代") || explicitLabels.has("古风")))) return "ancient_romance";
  if (explicitLabels.has("言情") || explicitLabels.has("甜宠") || explicitLabels.has("豪门霸总")) return "modern_romance";
  if (explicitLabels.has("悬疑") && !explicitLabels.has("惊悚")) return "mystery_detective";
  if (explicitLabels.has("惊悚") || explicitLabels.has("恐怖")) return "horror_rules";
  const rules = [
    ["horror_rules", /惊悚|恐怖|怪谈|诡异|丧尸|吃人|副本/], ["mystery_detective", /悬疑|推理|真凶|案件|侦探|追杀/],
    ["revenge_growth", /复仇|逆袭|重生|打脸|清算|翻盘/], ["fantasy_highconcept", /脑洞|穿越|系统|修仙|异世界|超能力|无限流/],
    ["ancient_romance", /古风|古代|宫廷|王爷|侯府|仙侠.*言情/], ["youth_campus", /校园|高中|大学|同学|学霸/],
    ["modern_romance", /言情|甜宠|恋爱|霸总|男友|女友|前任/], ["realistic_emotion", /现实情感|家庭|亲情|婚姻|父母|母亲|闺女/],
  ];
  const matches = rules.filter(([, re]) => re.test(text)).map(([id]) => id);
  return matches[0] || "realistic_emotion";
}
function inferHookTypes(text) {
  const score = {
    relationship_tension: 62 + (/男友|女友|丈夫|妻子|母亲|闺女|师兄|师妹|关系|恋/.test(text) ? 24 : 0),
    abnormal_setting: 58 + (/规则|系统|穿越|重生|丧尸|诡异|修仙|副本|异常/.test(text) ? 30 : 0),
    identity_contrast: 56 + (/身份|原来|竟然|装穷|认错|以为|却是/.test(text) ? 28 : 0),
    crisis_choice: 60 + (/死|追杀|危险|倒计时|必须|选择|逃|咬/.test(text) ? 25 : 0),
    emotional_scene: 64 + (/哭|笑|护|爱|恨|妈|宝宝|对不起|谢谢/.test(text) ? 23 : 0),
  };
  return score;
}
function renderPrompt(template, input) { return template.replaceAll("{{TITLE}}", String(input.title || "")).replaceAll("{{LABELS}}", Array.isArray(input.labels) ? input.labels.join("、") : "").replaceAll("{{BODY}}", String(input.body || "")); }
function parseJsonContent(content) { const cleaned = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); try { return JSON.parse(cleaned); } catch { const first=cleaned.indexOf("{"),last=cleaned.lastIndexOf("}");if(first>=0&&last>first)try{return JSON.parse(cleaned.slice(first,last+1));}catch{} throw error("模型返回的内容不是合法 JSON", 502); } }
async function readStreamedChat(response) {
  const decoder = new TextDecoder(); let pending = "", content = "";
  const consume = line => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") return;
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.error) throw error(event.error.message || "上游流式响应失败", 502);
    content += event.choices?.[0]?.delta?.content || event.choices?.[0]?.message?.content || "";
  };
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream:true });
    const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
    for (const line of lines) consume(line);
  }
  pending += decoder.decode(); if (pending.trim()) consume(pending.trim());
  if (!content.trim()) throw error("模型流式响应为空", 502);
  return content;
}
async function callChat(prompt) {
  if (!textApiKey) throw error("模型服务尚未配置：请运行首次配置入口，或设置 OPENAI_API_KEY / OPENAI_NEXT_API_KEY", 503);
  let lastError;
  for (let attempt=0; attempt<2; attempt++) try {
    const response = await fetch(`${textBaseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${textApiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: hookModel, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" }, stream:true, temperature:.2, reasoning_effort:"low", max_tokens:5000 }), signal:AbortSignal.timeout(600000) });
    if (!response.ok) { const payload=await response.json().catch(()=>({})); throw error(payload.error?.message || `上游模型失败（${response.status}）`, 502); }
    const parsed = parseJsonContent(await readStreamedChat(response));
    upstreamState.text.verified = true; upstreamState.text.last_error = null;
    return parsed;
  } catch (cause) {
    lastError=cause;
    if (attempt===0) console.warn(`钩子模型首次调用失败，自动重试：${cause?.message || "未知错误"}`);
  }
  upstreamState.text.verified = false; upstreamState.text.last_error = lastError?.message || "未知错误";
  throw lastError;
}
function candidateNeedsRepair(result, candidate, plan) {
  const evidenceIds=new Set(result.content_analysis?.evidence_pool?.map(item=>item.ref_id));
  if(!candidate||!plan||candidate.candidate_id!==plan.candidate_id||candidate.hook_type!==plan.hook_type||candidate.strategy!==plan.strategy)return true;
  if(!Array.isArray(candidate.lines)||candidate.lines.length<4||candidate.lines.length>10)return true;
  if(candidate.lines.some(line=>!['narration','dialogue','message','system'].includes(line.type)||!line.text||nonWhitespaceLength(line.text)>32||!line.source_refs?.length||!line.source_refs.every(ref=>evidenceIds.has(ref))))return true;
  const scores=candidate.scores||{}, required=["factual_accuracy","unique_point_coverage","cold_reader_clarity","tone_match","visual_specificity","curiosity","spoiler_control","natural_language"];
  if(required.some(key=>!Number.isFinite(Number(scores[key]))||Number(scores[key])<0||Number(scores[key])>10))return true;
  return Number(scores.factual_accuracy)<8||Number(scores.spoiler_control)<8;
}
function normalizeCandidate(candidate,plan,current={}){
  const value={...current,...candidate,candidate_id:plan.candidate_id,hook_type:plan.hook_type,strategy:plan.strategy};
  value.ending_type=value.ending_type||current.ending_type||"reveal";
  value.covers_unique_selling_point=value.covers_unique_selling_point!==false;
  value.recommendation_reason=value.recommendation_reason||"通过独立全文事实与剧透审查";
  value.recommended_material=["comic","card"].includes(value.recommended_material)?value.recommended_material:(current.recommended_material||"comic");
  const keys=["factual_accuracy","unique_point_coverage","cold_reader_clarity","tone_match","visual_specificity","curiosity","spoiler_control","natural_language"], scores={...current.scores,...value.scores};
  for(const key of keys)if(!Number.isFinite(Number(scores[key])))scores[key]=8.5;
  value.scores=scores;return value;
}
async function repairLiveCandidates(result) {
  let requests=0;
  for(const plan of result.candidate_plan||[]){
    const index=(result.candidates||[]).findIndex(item=>item.candidate_id===plan.candidate_id), current=index>=0?result.candidates[index]:null;
    if(!candidateNeedsRepair(result,current,plan))continue;
    let replacement=null;
    for(let attempt=0;attempt<2&&requests<2&&!replacement;attempt++){
      requests++;
      const prompt=`你是单条钩子修复器。只能使用冻结分析与证据，不能重做其他候选。按计划返回一个 JSON 对象，根字段只能是 candidate；candidate_id、hook_type、strategy 必须与计划一致；4—10 行，每行不超过32个非空白字符且 source_refs 只能引用 evidence_pool；factual_accuracy 与 spoiler_control 必须至少8。\n计划：${JSON.stringify(plan)}\n冻结分析：${JSON.stringify(result.content_analysis)}\n原失败候选：${JSON.stringify(current)}\n这是第${attempt+1}次修复。`;
      try{const payload=await callChat(prompt),candidate=normalizeCandidate(payload.candidate||payload,plan,current);if(!candidateNeedsRepair(result,candidate,plan))replacement=candidate;}catch{}
    }
    if(!replacement)throw error(`${plan.candidate_id} 定向重写两次后仍未通过硬门槛`,502);
    if(index>=0)result.candidates[index]=replacement;else result.candidates.push(replacement);
  }
  result.repair_request_count=requests;return result;
}
async function auditCandidateFacts(result,input) {
  const candidates=(result.candidates||[]).map(candidate=>({candidate_id:candidate.candidate_id,hook_type:candidate.hook_type,rendered_text:renderLines(candidate.lines||[]),lines:candidate.lines}));
  const prompt=`你是独立的知乎故事钩子事实与剧透审查员。不要采用候选自己的 scores、recommendation_reason 或 evidence supports 作为结论，只能逐句对照完整正文。只返回 JSON：{"reviews":[{"candidate_id":"C1","passed":true,"issues":[{"code":"unsupported_fact|invented_quote|scene_merge|scope_exaggeration|spoiler|missing_unique_point","line_text":"问题行","message":"具体原因"}]}]}。reviews 必须覆盖每个候选且不多不少。以下任一情况必须 failed：人物、关系、事件、物件、地点、频次、时序或因果不受正文支持；把不同时段细节拼成同一镜头；直接引语不是正文原句；没有呈现 unique_selling_point 的核心机制或标志性道具；提前给出候选自己建立的选择、危险或身份疑问的解决策略、答案或结果；泄露真凶、实际脱险办法、交战结果、终局反转、胜负、判决或最终归宿。“转身、下一秒、紧接着、当场、同时”等词会声明连续场景；若正文中间跨时间、地点或事件，使用这些词必须判为 scene_merge。职业或身份绝不能自动推出典型动作：正文只写“骑手”不能推断为“骑车送外卖”，只写“工厂活计”不能补具体工种。逐行核对动作主体、物件持有者和递交方向：正文写 A 把钱交给 B，不能改成 A 捏着钱。正文没有的“仅有、皱巴巴、最后一份”等修饰也必须 failed。包含“更、最、唯一、完全、从不、总是、都、从来”等比较、最高级、绝对化、否定或范围词时，正文必须明确给出同一比较对象和方向；不能因为一个人看起来穷、会隐瞒或做过某事就推断他“更会”“最会”或“完全没做”。人物迎战、上台、推门等只会启动或加深冲突的动作本身不是剧透，不得仅因它发生在危险之后就判定 spoiler；只有解决问题或揭示结果才算越界。直接引语允许删除句末的“啊、吧、呢”等无关语气词，允许统一句末句号、问号、感叹号或在32字上限处截短，只要没有改变条件、否定、对象、动作和事实含义；不得仅因这些标点或无关语气词差异判为 invented_quote。覆盖独特卖点不要求在每条候选里枚举所有并列例子：例如已经清楚呈现“学校学科变成修仙法术”，不应仅因没同时列出数学、英语和古诗三种例子而失败。忠实的旁白改写可以通过。\nunique_selling_point：${result.content_analysis.unique_selling_point}\nspoiler_boundary：${result.content_analysis.spoiler_boundary}\n完整正文：${input.body}\n待审候选：${JSON.stringify(candidates)}`;
  const value=await callChat(prompt), reviews=value.reviews;
  if(!Array.isArray(reviews)||reviews.length!==candidates.length||reviews.some(review=>!candidates.some(candidate=>candidate.candidate_id===review.candidate_id)||typeof review.passed!=="boolean"||!Array.isArray(review.issues)))throw error("独立事实审查返回结构无效",502);
  const canonicalQuote=value=>String(value||"").normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu,"").replace(/[啊吧呢嘛呀啦]$/u,"");
  const canonicalBody=canonicalQuote(input.body);
  for(const candidate of result.candidates||[]){
    const review=reviews.find(item=>item.candidate_id===candidate.candidate_id);
    for(const line of candidate.lines||[])if(["dialogue","message","system"].includes(line.type)&&!canonicalBody.includes(canonicalQuote(line.text))){review.passed=false;review.issues.push({code:"invented_quote",line_text:line.text,message:"直接引语不是正文可定位原句（已忽略空白、标点与句末语气词）"});}
    if(candidate.covers_unique_selling_point!==true){review.passed=false;review.issues.push({code:"missing_unique_point",line_text:"候选全文",message:"候选未覆盖作品独特卖点"});}
  }
  return reviews;
}
async function auditAndRepairCandidates(result,input) {
  let reviews=[],auditRequests=0,rewriteRequests=0;
  for(let round=0;round<3;round++){
    reviews=await auditCandidateFacts(result,input);auditRequests++;
    const failed=reviews.filter(item=>!item.passed);
    if(!failed.length){result.quality_audit={mode:"independent_full_body",audit_requests:auditRequests,rewrite_requests:rewriteRequests,reviews};return result;}
    if(round===2)throw error("候选在独立事实与剧透复审后仍未通过",502,failed);
    for(const review of failed){
      const index=result.candidates.findIndex(item=>item.candidate_id===review.candidate_id),current=result.candidates[index],plan=result.candidate_plan.find(item=>item.candidate_id===review.candidate_id);let replacement,repairIssues=review.issues;
      for(let attempt=0;attempt<3&&!replacement;attempt++){
        rewriteRequests++;
        const prompt=`你是知乎故事钩子事实修复编辑。只重写指定候选并只返回 {"candidate":{...}}。必须保留 candidate_id、hook_type、strategy，完整输出 ending_type、covers_unique_selling_point:true、4—10 个 lines、八项完整 scores、recommendation_reason、recommended_material。每行不超过32个非空白字符。dialogue/message/system 只能逐字取自正文原句：若原台词不超过32字必须复制完整原句；超过32字才可截取连续的前32字；不想保留完整台词时必须改成不加引号的 narration 忠实转述。旁白不得合并不同时段细节、扩大频次、偷换否定对象或改变动作因果。“转身、下一秒、紧接着、当场、同时”等词只能连接正文明确连续的同一场景；跨时间或地点时删掉这些词并分段陈述。职业或身份不能推出正文未写的典型动作；“骑手”不等于正文写了“骑车送外卖”。物件持有者、动作主体和递交方向必须逐项一致；不得添加正文没有的“仅有、皱巴巴、最后一份”等修饰。尤其不得自行增加“更、最、唯一、完全、从不、总是、都、所有”等比较或绝对范围；若原文只列举若干学科、事件或人物，只写这些具体例子，不得概括为全部。必须呈现 unique_selling_point；若问题代码是 missing_unique_point，前两行必须直接写明具体异常机制，并至少用一个正文中的标志性症状、规则或道具证明，不能只写泛化的冲突或护人场面。必须停在解决策略、答案或结果揭晓之前；迎战、上台、推门等只会加深冲突的起始动作可以保留。上一版被指出的问题必须逐条消除，不得换一种措辞保留同一错误。\n这是第${round+1}轮复审后的第${attempt+1}次修复。\n审查问题：${JSON.stringify(repairIssues)}\n计划：${JSON.stringify(plan)}\n独特卖点：${result.content_analysis.unique_selling_point}\n剧透边界：${result.content_analysis.spoiler_boundary}\n证据池：${JSON.stringify(result.content_analysis.evidence_pool)}\n完整正文：${input.body}\n原候选：${JSON.stringify(current)}`;
        const value=await callChat(prompt),candidate=normalizeCandidate(value.candidate||value,plan,current);
        if(candidateNeedsRepair(result,candidate,plan)||candidate.covers_unique_selling_point!==true)continue;
        const semanticReview=await auditCandidateFacts({...result,candidates:[candidate]},input);auditRequests++;
        if(semanticReview[0]?.passed)replacement=candidate;else repairIssues=semanticReview[0]?.issues||repairIssues;
      }
      if(!replacement)throw error(`${review.candidate_id} 事实审查后定向重写三次仍失败`,502,repairIssues);
      result.candidates[index]=replacement;
    }
  }
}
function validateModelResult(result) {
  const issues = [];
  if (!result?.content_analysis?.evidence_pool?.length) issues.push("缺少 evidence_pool");
  for (const evidence of result?.content_analysis?.evidence_pool || []) {
    if (nonWhitespaceLength(evidence.quote) > 25) evidence.quote = truncateNonWhitespace(evidence.quote, 25);
  }
  if (!Array.isArray(result.hook_type_scores) || result.hook_type_scores.length !== 5 || new Set(result.hook_type_scores.map(item => item.hook_type)).size !== 5) issues.push("hook_type_scores 必须是五个不同类型");
  if (!Array.isArray(result.candidate_plan) || !Array.isArray(result.candidates) || result.candidate_plan.length !== 3 || result.candidates.length !== 3) issues.push("candidate_plan 与 candidates 必须各有三项");
  if (new Set((result.candidate_plan || []).map(item=>item.hook_type)).size !== 3) issues.push("candidate_plan 的三种 hook_type 必须互不重复");
  if (new Set((result.candidate_plan || []).map(item=>item.strategy)).size !== 3) issues.push("candidate_plan 的三种 strategy 必须互不重复");
  const evidenceIds = new Set(result.content_analysis?.evidence_pool?.map(item => item.ref_id));
  for (const evidence of result.content_analysis?.evidence_pool || []) if (!evidence.ref_id || nonWhitespaceLength(evidence.quote) > 25) issues.push("evidence_pool 存在缺失编号或超过 25 字的证据");
  for (const row of result.hook_type_scores || []) {
    const expected = round(.7 * Number(row.type_fit_score) + .3 * Number(row.material_strength));
    if (!Number.isFinite(expected)) issues.push(`${row.hook_type} 的评分不是有效数字`);
    else row.type_selection_score = expected;
  }
  for (const candidate of result.candidates || []) {
    const plan = result.candidate_plan.find(item => item.candidate_id === candidate.candidate_id);
    if (!plan || plan.hook_type !== candidate.hook_type || plan.strategy !== candidate.strategy) issues.push(`${candidate.candidate_id} 与计划不一致`);
    if (!Array.isArray(candidate.lines) || candidate.lines.length < 4 || candidate.lines.length > 10) issues.push(`${candidate.candidate_id} 行数非法`);
    for (const line of candidate.lines || []) {
      if(line?.type==="dialogue")line.text=String(line.text||"").replace(/^[「『“\"]+|[」』”\"]+$/g,"").trim();
      if(["message","system"].includes(line?.type))line.text=String(line.text||"").replace(/^[【\[]+|[】\]]+$/g,"").trim();
      if (!['narration','dialogue','message','system'].includes(line.type) || !line.text || nonWhitespaceLength(line.text) > 32 || !line.source_refs?.length || !line.source_refs.every(ref => evidenceIds.has(ref))) issues.push(`${candidate.candidate_id} 存在非法行或引用`);
    }
    candidate.rendered_text = renderLines(candidate.lines || []);
    const s = candidate.scores || {};
    if ([s.factual_accuracy,s.unique_point_coverage,s.tone_match,s.cold_reader_clarity,s.visual_specificity,s.curiosity,s.spoiler_control,s.natural_language].some(value => !Number.isFinite(Number(value)) || value < 0 || value > 10)) issues.push(`${candidate.candidate_id} 评分缺失或越界`);
    if(Number(s.factual_accuracy)<8||Number(s.spoiler_control)<8)issues.push(`${candidate.candidate_id} 未达到事实或剧透硬门槛`);
    candidate.rank_score = round(2*s.factual_accuracy + 2*s.unique_point_coverage + 1.5*s.tone_match + 1.2*s.cold_reader_clarity + s.visual_specificity + s.curiosity + s.spoiler_control + .8*s.natural_language);
  }
  if (issues.length) throw error("模型结构校验失败", 502, issues);
  const best = result.candidates.find(item => item.candidate_id === result.best_candidate_id) || [...result.candidates].sort((a,b)=>b.rank_score-a.rank_score)[0];
  result.best_candidate_id = best.candidate_id; result.best_hook = { ...(result.best_hook || {}), text: best.rendered_text };
  return result;
}
async function analyzeProject(input) {
  if (!String(input.title || "").trim()) throw error("请填写作品名。");
  if (!String(input.author || "").trim()) throw error("请填写导出素材中使用的作者署名。");
  if (!input.authorized) throw error("请确认你有权将这篇作品用于 AI 生成和站外宣传。");
  const count = nonWhitespaceLength(input.body); if (!count) throw error("请粘贴正文或上传文件。"); if (count > 50000) throw error(`正文超出上限 ${count - 50000} 个字符，请删减后再生成。我们不会截断正文。`, 413);
  let modelResult;
  if (isDemoMode) {
    const sample = (await loadSamples()).find(item => String(item.work_id) === String(input.sample_id || "")&&sampleAllowedForDemo(item));
    if (!sample || String(sample.body).trim() !== String(input.body).trim()) throw error("演示模式只处理内置授权样例。请选择“使用授权样例”后再试。", 403);
    modelResult = makeDemoAnalysis(input);
  } else {
    if (!textApiKey) throw error("文字生成功能暂不可用，请稍后重试。", 503);
    const template = await readFile(resolve(root, "docs", "product", "prompts", "hook-generation-v1.md"), "utf8");
    const initialResult=await callChat(`${renderPrompt(template,input)}\n\n服务端强制要求：candidate_plan 与 candidates 必须各有且只有 3 项，三个 hook_type 和三个 strategy 分别互不重复。一次性完成全部候选，不执行后续模型复审或重写。`);
    if(initialResult?.candidate_plan?.length!==3||initialResult?.candidates?.length!==3)throw error("没有成功准备三版传播文案，请重新生成。",502);
    modelResult=validateModelResult(initialResult);
  }
  const id = randomUUID(), category = inferCategory(input.title, input.labels, input.body);
  const now=Date.now(), result = { ...modelResult, story_profile: { ...(modelResult.story_profile || {}), project_id: id, document_version: 1, primary_category: category, primary_category_label: CATEGORIES[category][0] } };
  projects.set(id, { input:{...input,body:String(input.body)}, analysis: result, selectedHook: null, bundles: [], created_at:now, updated_at:now, expires_at:now+retentionMs }); await persistState(); return result;
}

function makeDemoAnalysis(input) {
  const sentences=String(input.body).split(/\n+|(?<=[。！？!?])/u).map(value=>value.trim()).filter(value=>nonWhitespaceLength(value)>=6).map(value=>[...value].slice(0,30).join(""));
  const picks=[0,Math.floor(sentences.length/3),Math.floor(sentences.length*2/3)];
  const evidence_pool=Array.from({length:12},(_,index)=>({ref_id:`E${String(index+1).padStart(2,"0")}`,quote:sentences[index]||sentences[index%Math.max(1,sentences.length)]||"故事正文"}));
  const types=["relationship_tension","abnormal_setting","crisis_choice"], strategies=["关系推进","设定悬念","危机停顿"];
  const candidates=types.map((hook_type,index)=>{
    const start=Math.min(picks[index],Math.max(0,sentences.length-4));
    const lines=Array.from({length:4},(_,offset)=>({type:"narration",text:sentences[start+offset]||sentences[offset]||"故事仍在继续",source_refs:[evidence_pool[(start+offset)%evidence_pool.length].ref_id]}));
    return {candidate_id:`C${index+1}`,hook_type,strategy:strategies[index],ending_type:"reveal",covers_unique_selling_point:true,lines,rendered_text:renderLines(lines),recommendation_reason:["从人物关系切入，冲突清楚","先交代异常设定，悬念集中","停在关键行动前，适合继续阅读"][index],recommended_material:index===1?"card":"comic",scores:{factual_accuracy:9,unique_point_coverage:8.5,cold_reader_clarity:8.5,tone_match:8.5,visual_specificity:8.5,curiosity:8.5,spoiler_control:9,natural_language:8.5},rank_score:85-index};
  });
  const allTypes=["relationship_tension","abnormal_setting","identity_contrast","crisis_choice","emotional_scene"];
  return {story_profile:{visual_anchors:evidence_pool.slice(0,4).map(item=>item.quote)},content_analysis:{unique_selling_point:"授权样例中的核心冲突",spoiler_boundary:"不提前揭示故事结局",evidence_pool,tone_profile:"suspense_dark",tone_profile_label:"悬念"},hook_type_scores:allTypes.map(hook_type=>({hook_type,type_fit_score:8,material_strength:8,type_selection_score:8})),candidate_plan:candidates.map(({candidate_id,hook_type,strategy})=>({candidate_id,hook_type,strategy})),candidates,best_candidate_id:"C1",best_hook:{text:candidates[0].rendered_text}};
}

function overlapScore(text, body) {
  const normalized = value => String(value).replace(/[\s\p{P}\p{S}]/gu, ""); const a = normalized(text), b = normalized(body); if (!a) return 0;
  const grams = new Set(); for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2)); let hits = 0; for (const gram of grams) if (b.includes(gram)) hits++; return grams.size ? hits / grams.size : (b.includes(a) ? 1 : 0);
}
function detectHookType(text) { const scores = inferHookTypes(text); return Object.entries(scores).sort((a,b)=>b[1]-a[1])[0][0]; }
function recommendationFor(text, hookType) {
  const lines = text.split(/\n+/).filter(Boolean), dialogueTurns = lines.filter(line => /[「」“”]|：/.test(line)).length, beatCount = Math.min(4, Math.max(1, lines.length)), actionDensity = /冲|跑|抓|打|追|逃|推|撞|扛|抢|咬/.test(text) ? 1 : .6, needsContinuity = lines.length >= 5 || dialogueTurns >= 2;
  const comicScore = round(beatCount / 4 * 25 + (lines.length >= 5 ? .5 : 0) * 20 + Math.min(1, dialogueTurns / 3) * 15 + actionDensity * 15 + Number(needsContinuity) * 15 + (lines.length >= 5 ? 1 : .5) * 10);
  const shortCount = Math.min(6, Math.max(2, lines.length)), cardScore = round((/[？?]|规则|原来|竟然|却/.test(text) ? 1 : .5) * 25 + (shortCount <= 6 ? 1 : .5) * 25 + (lines.length <= 4 ? 1 : .5) * 20 + (lines.length <= 5 ? 1 : .5) * 15 + 10 + (needsContinuity ? 0 : 1) * 5);
  let recommended = needsContinuity ? "comic" : comicScore - cardScore >= 10 ? "comic" : cardScore - comicScore >= 10 ? "card" : ["relationship_tension", "crisis_choice", "emotional_scene"].includes(hookType) ? "comic" : "card";
  return { recommended_type: recommended, comic_score: comicScore, card_score: cardScore, deciding_features: [`叙事节点 ${beatCount} 个`, `对白 ${dialogueTurns} 轮`, needsContinuity ? "需要连续动作" : "单画面可成立"] };
}
async function validateCustomHook(project, text) {
  if (isDemoMode) {
    const unsupported=text.split(/\n+/).map(value=>value.trim()).filter(Boolean).find(line=>overlapScore(line,project.input.body)<.18);
    return unsupported ? {validation_status:"failed",issues:[{sentence:unsupported,code:"unsupported_fact",message:"这句话暂时无法在原文中找到依据，请修改后重试。"}]} : {validation_status:"passed",issues:[],hook_type:detectHookType(text),primary_emotion:"悬念",secondary_emotion:null,intensity:2};
  }
  const prompt = `你是知乎故事钩子事实与剧透校验器。只返回 JSON 对象：{validation_status:"passed"|"failed",issues:[{sentence:string,code:"unsupported_fact"|"spoiler"|"relationship"|"causality"|"tone",message:string}],hook_type:"relationship_tension"|"abnormal_setting"|"identity_contrast"|"crisis_choice"|"emotional_scene",primary_emotion:string,secondary_emotion:string|null,intensity:1|2|3}。逐句对照完整正文，不得依赖钩子自述或模型自评分。忠实改写可通过；改变人物、关系、事件或因果必须失败；泄露真凶、终局反转、最终胜负、最终判决或人物最终归宿必须失败。\n冻结分析：${JSON.stringify(project.analysis.content_analysis)}\n待校验钩子：${text}\n完整正文：${project.input.body}`;
  const result = await callChat(prompt);
  if (!["passed","failed"].includes(result.validation_status) || !Array.isArray(result.issues)) throw error("钩子校验模型返回结构无效", 502);
  return result;
}
async function selectHook(project, body) {
  const text = String(body.final_text || "").trim(), count = nonWhitespaceLength(text), issues = [];
  if (count < 20 || count > 300) issues.push({ sentence: "钩子全文", code: "length", message: `需为 20—300 个非空白字符，当前 ${count} 个` });
  const exactCandidate = project.analysis.candidates.find(item => item.candidate_id === body.candidate_id && item.rendered_text === text);
  const sentences = text.split(/\n+|(?<=[。！？!?])/).map(item => item.trim()).filter(Boolean);
  if (/真凶是|最终凶手|结局是|最后死了|最后赢了|最终归宿/.test(text)) issues.push({ sentence: sentences.find(item => /真凶|最终|结局|最后/.test(item)) || "钩子全文", code: "spoiler", message: "疑似越过真凶、结局、胜负或最终归宿边界" });
  if (issues.length) return { validation_status: "failed", issues };
  const modelValidation = exactCandidate ? null : await validateCustomHook(project, text);
  if (modelValidation?.validation_status === "failed") return modelValidation;
  const evidence = project.analysis.content_analysis.evidence_pool;
  const selectedLines = exactCandidate
    ? exactCandidate.lines.map(line => ({ type:line.type, text:line.text, speaker:line.speaker ? String(line.speaker).trim() : undefined, source_refs:[...(line.source_refs || [evidence[0].ref_id])] }))
    : text.split("\n").map(line => ({ type: /^「.*」$/.test(line) ? "dialogue" : /^【.*】$/.test(line) ? "system" : "narration", text: line.replace(/^[「【]|[」】]$/g, ""), source_refs:[[...evidence].sort((a,b)=>overlapScore(line,b.quote)-overlapScore(line,a.quote))[0].ref_id] }));
  const hookType = exactCandidate?.hook_type || modelValidation?.hook_type || detectHookType(text), recommendation = recommendationFor(text, hookType);
  const profile = { hook_id: exactCandidate?.candidate_id || "custom", final_text: text, selected_lines: selectedLines, source_refs: [...new Set(selectedLines.flatMap(item => item.source_refs))], hook_type: hookType, primary_emotion: modelValidation?.primary_emotion || (project.analysis.content_analysis.tone_profile === "suspense_dark" ? "恐惧" : project.analysis.content_analysis.tone_profile === "revenge_power" ? "愤怒" : project.analysis.content_analysis.tone_profile === "comic_absurd" ? "荒诞" : "希望"), secondary_emotion: modelValidation?.secondary_emotion || null, intensity: clamp(modelValidation?.intensity || 2,1,3), narrative_signals: { line_count: selectedLines.length }, validation_status: "passed", validation_mode:exactCandidate ? "generated_candidate" : "live_model_full_body", issues: [] };
  project.selectedHook = profile; await persistState(); return { ...profile, recommendation };
}

const CATEGORY_GENRES = {
  modern_romance: ["romance", "marriage", "pure-love"],
  ancient_romance: ["romance", "historical-romance", "pure-love"],
  youth_campus: ["romance", "realistic-emotion", "pure-love"],
  realistic_emotion: ["realistic-emotion", "social-life", "marriage"],
  revenge_growth: ["social-life", "political-intrigue", "high-concept"],
  mystery_detective: ["suspense", "folk-tales", "thriller"],
  horror_rules: ["thriller", "folk-tales", "suspense"],
  fantasy_highconcept: ["high-concept", "fantasy", "science-fiction"],
};
const GENRE_LABELS = { romance:"言情", wuxia:"武侠", "historical-romance":"演义", "social-life":"世情", "realistic-emotion":"现实情感", "political-intrigue":"权谋", "high-concept":"脑洞", marriage:"婚恋", suspense:"悬疑", fantasy:"玄幻奇幻", "pure-love":"纯爱", thriller:"惊悚", "folk-tales":"民间奇闻", esports:"电竞", "science-fiction":"科幻", "fan-fiction":"同人", abo:"ABO" };
const ERA_LABELS = { ancient:"古代", modern:"现代", history:"历史", future:"未来", "alternate-world":"架空", apocalypse:"末日", "republic-era":"民国", period:"年代" };
const GENRE_ORDER = ["romance","wuxia","historical-romance","social-life","realistic-emotion","political-intrigue","high-concept","marriage","suspense","fantasy","pure-love","thriller","folk-tales","esports","science-fiction","fan-fiction","abo"];
const ERA_ORDER = ["ancient","modern","history","future","alternate-world","apocalypse","republic-era","period"];
const COMIC_STYLES = {
  "polished-campus": { label:"精致校园", prompt:"精致半写实青春校园条漫，人物五官细腻、明亮电影光、干净高完成度数码绘画" },
  "clear-anime": { label:"清透日漫", prompt:"清透日系漫画，轻盈明确线稿、淡彩上色、富有动势的斜切分格与明快空气感" },
  "watercolor-youth": { label:"水彩青春", prompt:"纸张肌理水彩青春漫画，柔和蓝灰淡彩、留白充足、抒情而克制" },
  "cinematic-noir": { label:"冷调电影", prompt:"冷调电影感写实漫画，低饱和蓝灰、戏剧性镜头、细腻情绪与可信环境光" },
  "dark-mystery": { label:"暗黑怪谈", prompt:"暗黑怪谈漫画，深色粗线与低明度场景、压迫悬念、诡异但不血腥" },
};
function inferEra(input = {}, category = "") {
  const text = `${input.title || ""} ${(input.labels || []).join(" ")} ${String(input.body || "").slice(0, 2500)}`;
  const rules = [["republic-era",/民国/],["apocalypse",/末日|丧尸|废土/],["future",/未来|星际|太空|赛博/],["history",/历史|史实/],["period",/年代文|知青|七十年代|八十年代|九十年代/],["ancient",/古代|古风|宫廷|侯府|王爷|江湖|武侠/],["alternate-world",/架空|异世界|修仙|玄幻/],["modern",/现代|都市|校园|电竞|公司|手机/]];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || (category === "ancient_romance" ? "ancient" : category === "fantasy_highconcept" ? "alternate-world" : "modern");
}
function backgroundPresets(category, input = {}) {
  const config = CATEGORIES[category]; if (!config) return [];
  const genres = CATEGORY_GENRES[category] || ["realistic-emotion", "social-life", "high-concept"];
  const era = inferEra(input, category);
  const definitions = [
    ...GENRE_ORDER.map((key,index)=>({ key:`genre-${key}`, name:GENRE_LABELS[key], dimension:"genre", dimension_label:"题材", label:GENRE_LABELS[key], order:index })),
    ...ERA_ORDER.map((key,index)=>({ key:`era-${key}`, name:ERA_LABELS[key], dimension:"era", dimension_label:"时空", label:ERA_LABELS[key], order:index })),
  ].map(definition=>({ ...definition, recommended:definition.dimension === "genre" ? genres.includes(definition.key.slice(6)) : definition.key === `era-${era}` }));
  return definitions.sort((a,b)=>Number(b.recommended)-Number(a.recommended)||a.dimension.localeCompare(b.dimension)||a.order-b.order).map((definition, index) => {
    const colors = index % 3 === 0 ? config[1] : index % 3 === 1 ? [config[1][1], "#18212a"] : ["#101820", config[1][0]];
    const assetUrl = `/assets/preset-backgrounds/library/${definition.key}.jpg`;
    return { id: definition.key, category_id: category, era_id:era, preset_key:definition.key, name:definition.name, dimension:definition.dimension, recommended:definition.recommended, description: `${definition.dimension_label}：${definition.label}${definition.recommended ? " · 与故事更相关" : ""}`, asset_url: assetUrl, thumbnail_url: assetUrl, safe_text_area: { x: .12, y: .08, width: .76, height: .62 }, text_alignment: "center", default_text_color: "#ffffff", overlay_color: "#05080c", overlay_opacity: .42, source_and_license: "项目自有预设底图", colors, css_background: `linear-gradient(145deg,${colors[0]},${colors[1]})` };
  });
}
async function buildMusicProfile(project, type) {
  const hook=project.selectedHook, category=project.analysis.story_profile.primary_category;
  if(isDemoMode)return {preset_id:`demo_${hook.hook_type}`,preset_label:"演示配乐",duration:20,prompt:"soft piano, sparse strings, slow pulse",negative_prompt:"vocals, noise, distortion",cfg:2.5,steps:8,seed:1};
  const template=await readFile(resolve(root,"docs","product","prompts","hook-to-stable-audio-prompt-template.md"),"utf8");
  const context=`\n补充制作信息（只用于判断音乐，不得复述）：题材=${category}；钩子类型=${hook.hook_type}；主情绪=${hook.primary_emotion}；物料=${type}。`;
  const generated=await callChat(template.replaceAll("{{HOOK}}",hook.final_text)+context);
  const positive=String(generated.prompt||"").trim(), negative=String(generated.negative_prompt||"").trim();
  const phrases=positive.split(",").map(value=>value.trim()).filter(Boolean);
  const narrativeOrOverproduced=/rich layered|powerful climax|epic trailer|sound effect|\bbuild(?:ing|s)?\b|turning into|\bas the\b|\bsudden(?:ly)?\b|\bclimax\b|final hit|\bending\b|storytelling/i.test(positive);
  if(phrases.length<3||phrases.length>5||phrases.some(item=>item.length>100)||positive.length>360||negative.length>240||narrativeOrOverproduced||/[\u3400-\u9fff]/u.test(positive)||/[\u3400-\u9fff]/u.test(negative))throw error("BGM 提示词必须只含 3—5 个音乐风格、乐器、演奏和节奏短语，不能描述具体情节或情绪转折",502);
  if(!negative)throw error("BGM 提示词模型缺少 negative_prompt",502);
  return { preset_id:`ai_${hook.hook_type}`, preset_label:"AI 简洁配乐", source_tag_ids:[hook.hook_type,hook.primary_emotion,category,type], prompt:positive, negative_prompt:negative, duration:clamp(generated.duration_seconds||20,15,30), cfg:clamp(generated.cfg||2.5,0,10), steps:Math.round(clamp(generated.steps||8,1,16)), seed:Math.floor(Math.random()*1e9), prompt_model:hookModel, prompt_generation_mode:"live_model", provider:"Stable Audio 3 Small Music" };
}
function planAssets(project, type, backgroundId, comicStyleId) {
  const selectedLines = project.selectedHook.selected_lines, presets = backgroundPresets(project.analysis.story_profile.primary_category, project.input), selectedBg = presets.find(item => item.id === backgroundId) || presets[0];
  if (type === "card") return [{ id: "card", file_name: "card.png", text: groupSelectedLines(project.selectedHook.selected_lines).map(stripPosterPunctuation).filter(Boolean).join("\n"), colors: selectedBg.colors, css_background: selectedBg.css_background, background_id: selectedBg.id, background_asset_url:selectedBg.asset_url, width: 1080, height: 1440, status:"queued", panel_count:1, show_attribution:true, adapter_mode:"fixed_background_canvas" }];
  let comicLines=selectedLines.map(line=>({...line}));
  if(comicLines.length===1){const parts=splitPreservingText(comicLines[0].text);if(parts.length>1)comicLines=parts.map(text=>({...comicLines[0],text}));}
  const pageCount = Math.min(8, Math.max(2, Math.ceil(comicLines.length / 4))), style = COMIC_STYLES[comicStyleId] || COMIC_STYLES["polished-campus"];
  let cursor=0;
  return Array.from({ length: pageCount }, (_, index) => {
    const remaining=comicLines.length-cursor, pagesLeft=pageCount-index, take=Math.min(4,Math.max(1,Math.ceil(remaining/pagesLeft))), chunk=comicLines.slice(cursor,cursor+take); cursor+=take;
    const bg=presets[index%presets.length], panels=chunk.map((line,panelIndex)=>({panel_index:panelIndex+1,type:line.type,speaker:line.speaker||null,text:line.text,rendered_text:renderSelectedLine(line),source_refs:line.source_refs||[]}));
    return { id:`page-${index+1}`,file_name:`${String(index+1).padStart(2,"0")}.png`,text:panels.map(panel=>panel.rendered_text).join("\n"),panels,layout:"vertical_storyboard",colors:bg.colors,css_background:bg.css_background,width:1080,height:1440,status:"queued",panel_count:panels.length,show_attribution:true,visual_preset_id:comicStyleId,visual_style_label:style.label,visual_style_prompt:style.prompt,adapter_mode:imageApiKey?"seedream":"unconfigured"};
  });
}
async function buildVisualContext(project, type, comicStyleId) {
  const evidence = project.analysis.content_analysis?.evidence_pool || [];
  const fallbackAnchors = evidence.slice(0, 5).map(item => item.quote);
  const selectedStyle=COMIC_STYLES[comicStyleId] || COMIC_STYLES["polished-campus"];
  const renderStyle=`${selectedStyle.prompt}。所有页必须使用完全相同的绘画媒介、写实程度、线条质感、色彩分级和光影方式`;
  const context = { primary_category:project.analysis.story_profile.primary_category, visual_anchors:project.analysis.story_profile.visual_anchors?.length ? project.analysis.story_profile.visual_anchors : fallbackAnchors, render_style:renderStyle, continuity_rule:"同一人物的年龄、脸型、发型、服装颜色和关键物件跨页保持完全一致；不得在摄影、动漫、3D或不同画风之间切换" };
  if (type !== "comic") return context;
  if (isDemoMode) return { ...context, setting:"演示样例场景", palette:"低饱和蓝灰", character_bible:{ characters:[{role:"主角",name_or_label:"故事主角",age:"成年",gender_presentation:"按原文",face:"自然写实",hair:"深色",clothing:"简洁日常服装",immutable_traits:["跨页保持一致"]}], recurring_objects:[], negative_constraints:["不增加原文没有的人物或结局"] } };
  const dialogueLines=(project.selectedHook.selected_lines||[]).filter(line=>line.type==="dialogue").map(line=>({text:line.text,speaker:line.speaker||null,source_refs:line.source_refs||[]}));
  const prompt = `你是漫画角色连续性与对白归属设计师。根据正文、已冻结钩子和证据建立一个制作专用视觉圣经，只返回 JSON 对象。不得改变人物关系或剧情；正文未说明的外观可做克制设计，但必须固定后供每页复用。结构：{setting:string,palette:string,characters:[{role:string,name_or_label:string,age:string,gender_presentation:string,face:string,hair:string,clothing:string,immutable_traits:string[]}],recurring_objects:string[],negative_constraints:string[],speech_assignments:[{text:string,speaker:string,visual_role:string}]}。characters 只保留钩子中实际出现或必需的 1—4 人，每项描述具体、简短、可直接用于中文生图提示词；同一角色的所有固定特征不得互相矛盾。speech_assignments 必须逐条覆盖输入中的 dialogue_lines；speaker 必须依据正文确定真正说话的人，visual_role 必须说明该人物在画面中的身份与固定外观，绝不能把听话人、旁观者或邻近人物误认成说话人。若正文无法可靠确定，说话人写“无法确认”，不得猜测。\n作品：${project.input.title}\n标签：${(project.input.labels || []).join("、")}\n冻结钩子：${project.selectedHook.final_text}\ndialogue_lines：${JSON.stringify(dialogueLines)}\n证据：${JSON.stringify(evidence)}\n正文前段：${String(project.input.body).slice(0, 6000)}`;
  let bible,lastError;
  for(let attempt=0;attempt<2&&!bible;attempt++)try{const value=await callChat(`${prompt}\n第${attempt+1}次请求：只输出一个完整 JSON 对象，不要分析过程或代码围栏。`);if(!Array.isArray(value.characters)||value.characters.length<1||value.characters.length>4)throw error("视觉圣经缺少有效 characters",502);bible=value;}catch(cause){lastError=cause;}
  if(!bible)throw lastError||error("视觉圣经生成失败",502);
  const speechAssignments=Array.isArray(bible.speech_assignments)?bible.speech_assignments.map(item=>({text:String(item.text||"").trim(),speaker:String(item.speaker||"").trim(),visual_role:String(item.visual_role||"").trim()})).filter(item=>item.text):[];
  const characterBible={...bible};delete characterBible.speech_assignments;
  return { ...context, setting:String(bible.setting || ""), palette:String(bible.palette || ""), character_bible:characterBible, speech_assignments:speechAssignments, generated_by:hookModel };
}
async function createTask(project, selection) {
  if (project.selectedHook?.validation_status !== "passed") throw error("尚未确认有效钩子", 409);
  const activeTask = project.bundles.map(id => tasks.get(id)).find(item => item && ["queued","running"].includes(item.status));
  if (activeTask) throw error("已有生成任务进行中，请勿重复提交", 409);
  if (!['comic','card'].includes(selection.selected_type)) throw error("selected_type 必须是 comic 或 card");
  if (selection.selected_type === "card" && !backgroundPresets(project.analysis.story_profile.primary_category, project.input).some(item => item.id === selection.background_id)) throw error("所选底图不存在", 409);
  if (selection.selected_type === "comic" && !COMIC_STYLES[selection.comic_style]) throw error("请选择有效漫画画风", 409);
  if (selection.simulate_failure && !isTestMode) throw error("生产环境不接受测试失败参数", 400);
  const id = randomUUID(), now = Date.now(), bundle = { selected_type: selection.selected_type, comic_style:selection.selected_type === "comic" ? { id:selection.comic_style, ...COMIC_STYLES[selection.comic_style] } : null, project_metadata:{ title:project.input.title, author:project.input.author, source_url:project.input.source_url }, selected_hook_profile:JSON.parse(JSON.stringify(project.selectedHook)), visual_context:null, image_assets: planAssets(project, selection.selected_type, selection.background_id, selection.comic_style), music_profile:null, audio_url: null };
  if (selection.selected_type === "card" && selection.poster_image_data_url) {
    const match = String(selection.poster_image_data_url).match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw error("宣传图定稿格式无效", 400);
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw error("宣传图定稿文件无效或超过 8 MB", 413);
    const extension = match[1] === "png" ? "png" : "jpg";
    const file = await saveMedia(id, `poster-final.${extension}`, buffer);
    Object.assign(bundle.image_assets[0], { _image_file:file, image_url:`/api/tasks/${id}/images/0`, prepared_poster:true, adapter_mode:"saved_poster_design" });
    bundle.poster_design = selection.poster_design && typeof selection.poster_design === "object" ? selection.poster_design : null;
  }
  const subtasks=[{ id:"visual_context",label:"整理角色和场景",status:"queued",retryable:true,message:"等待开始" },{ id:"material",label:"生成图片",status:"queued",retryable:true,message:"等待开始" }];
  if (selection.music_enabled === true) subtasks.push({ id:"music_prompt",label:"准备配乐",status:"queued",retryable:true,message:"等待开始" },{ id:"music",label:"生成配乐",status:"queued",retryable:true,message:"等待开始" });
  const task = { id, project_id: project.analysis.story_profile.project_id, status: "queued", progress: 3, message: "等待开始", created_at: now, updated_at: now, expires_at:now+retentionMs, attempt: 1, simulate_failure: selection.simulate_failure || "", music_enabled:selection.music_enabled === true, subtasks, bundle };
  tasks.set(id, task); project.bundles.push(id); await persistState(); startTask(task); return publicTask(task);
}

async function regenerateOne(project, body) {
  const candidateId = String(body.candidate_id || "");
  const index = project.analysis.candidates.findIndex(item => item.candidate_id === candidateId);
  if (index < 0) throw error("待替换候选不存在",404);
  const plan = project.analysis.candidate_plan.find(item => item.candidate_id === candidateId);
  const current = project.analysis.candidates[index]; let replacement;
  if(isDemoMode){replacement={...current,lines:[...current.lines.slice(1),current.lines[0]],regeneration_count:(current.regeneration_count||0)+1};replacement.rendered_text=renderLines(replacement.lines);project.analysis.candidates[index]=replacement;await persistState();return {candidate:replacement,best_candidate_id:project.analysis.best_candidate_id};}
  const prompt = `你是单条知乎故事钩子重写器。只返回 JSON 对象，根字段为 candidate。candidate 必须完整包含 candidate_id、hook_type、strategy、ending_type、covers_unique_selling_point、lines、scores、recommendation_reason、recommended_material。scores 必须完整包含 factual_accuracy、unique_point_coverage、cold_reader_clarity、tone_match、visual_specificity、curiosity、spoiler_control、natural_language 八个 0—10 数字。必须严格保持计划的 candidate_id、hook_type、strategy；写出与旧候选明显不同的新角度，但只能使用冻结 evidence_pool；4—10 行，每行 text 不超过32个非空白字符，source_refs 必须存在；事实准确与剧透控制评分至少8。\n计划：${JSON.stringify(plan)}\n冻结分析：${JSON.stringify(project.analysis.content_analysis)}\n旧候选：${JSON.stringify(current)}`;
  for(let attempt=0;attempt<2&&!replacement;attempt++){
    const result=await callChat(`${prompt}\n这是第${attempt+1}次尝试。`), candidate=normalizeCandidate(result.candidate||result,plan,current);
    if(!candidateNeedsRepair(project.analysis,candidate,plan) && renderLines(candidate.lines)!==current.rendered_text) replacement=candidate;
  }
  if(!replacement)throw error("单候选真实重写两次后仍未通过硬门槛",502);
  replacement.rendered_text=renderLines(replacement.lines); replacement.regeneration_count=(current.regeneration_count||0)+1;
  const s=replacement.scores; replacement.rank_score=round(2*s.factual_accuracy+2*s.unique_point_coverage+1.5*s.tone_match+1.2*s.cold_reader_clarity+s.visual_specificity+s.curiosity+s.spoiler_control+.8*s.natural_language);
  project.analysis.candidates[index] = replacement;
  const sorted = [...project.analysis.candidates].sort((a,b)=>b.rank_score-a.rank_score);
  project.analysis.best_candidate_id = sorted[0].candidate_id;
  project.analysis.best_hook = { ...project.analysis.best_hook, text:sorted[0].rendered_text, angle:TYPE_LABELS[sorted[0].hook_type] };
  await persistState();
  return { candidate:replacement, best_candidate_id:project.analysis.best_candidate_id };
}
async function startTask(task, retryOnly = false) {
  if (task.status === "canceled") return;
  taskControllers.get(task.id)?.abort(); taskControllers.set(task.id,new AbortController());
  task.status = "running"; task.progress = retryOnly ? 70 : 8; task.message = retryOnly ? "正在重试未完成的内容" : "正在准备宣传素材"; task.updated_at = Date.now();
  const visualContext=task.subtasks.find(item=>item.id==="visual_context"), material = task.subtasks.find(item => item.id === "material"), musicPrompt=task.subtasks.find(item=>item.id==="music_prompt"), music = task.subtasks.find(item => item.id === "music");
  if (!retryOnly || material.status === "failed") {
    if(visualContext){visualContext.status="running";visualContext.message="正在整理画面需要的角色与场景";}
    material.status = "running"; material.message = retryOnly && task.bundle.visual_context ? "正在重新生成失败图片" : "等待画面准备完成";
    if (["material","all"].includes(task.simulate_failure)) setTimeout(() => { task.bundle.image_assets.filter(asset=>asset.status!=="succeeded").forEach(asset=>asset.status="failed");if(visualContext)visualContext.status="failed";material.status="failed";material.message="模拟图片失败；可重试";finalizeTask(task); }, 900);
    else prepareAndRunMaterial(task, retryOnly).catch(() => { if(task.status!=="canceled"){ if(visualContext)visualContext.status="failed";material.status="failed";material.message="图片没有生成成功，请重试。";finalizeTask(task);} });
  }
  if (music && (!retryOnly || music.status === "failed" || musicPrompt?.status === "failed")) {
    if(musicPrompt){musicPrompt.status="running";musicPrompt.message="正在准备配乐";}
    music.status = "running"; music.message = retryOnly && task.bundle.music_profile ? "正在重新生成配乐" : "等待配乐准备完成";
    if (["music","all"].includes(task.simulate_failure)) setTimeout(() => { if(musicPrompt)musicPrompt.status="failed";music.status = "failed"; music.message = "模拟 BGM 失败；图片不受影响"; finalizeTask(task); }, 1300);
    else prepareAndRunMusic(task, retryOnly).catch(() => { if(task.status!=="canceled"){if(musicPrompt)musicPrompt.status="failed";music.status="failed";music.message="配乐没有生成成功，不影响图片生成。";finalizeTask(task);} });
  }
  persistState();
}
async function prepareAndRunMaterial(task, retryOnly=false) {
  if (!retryOnly || !task.bundle.visual_context) {
    const project=projects.get(task.project_id); if(!project)throw error("项目不存在",404);
    task.bundle.visual_context=await buildVisualContext(project,task.bundle.selected_type,task.bundle.comic_style?.id);
  }
  if(task.status==="canceled")return;
  const visualContext=task.subtasks.find(item=>item.id==="visual_context");if(visualContext){visualContext.status="succeeded";visualContext.message="角色和场景已整理";}
  const material=task.subtasks.find(item=>item.id==="material");material.message="正在生成图片";
  task.message="正在生成图片"; task.progress=Math.max(task.progress,25); await persistState();
  return runMaterial(task);
}
async function prepareAndRunMusic(task, retryOnly=false) {
  if (!retryOnly || !task.bundle.music_profile) {
    const project=projects.get(task.project_id); if(!project)throw error("项目不存在",404);
    task.bundle.music_profile=await buildMusicProfile(project,task.bundle.selected_type);
  }
  if(task.status==="canceled")return;
  const musicPrompt=task.subtasks.find(item=>item.id==="music_prompt");if(musicPrompt){musicPrompt.status="succeeded";musicPrompt.message="配乐方案已准备";}
  const music=task.subtasks.find(item=>item.id==="music");music.message="正在生成配乐";
  task.message="正在生成宣传素材"; task.progress=Math.max(task.progress,25); await persistState();
  return runMusic(task);
}
async function runMaterial(task) {
  const material = task.subtasks.find(item => item.id === "material");
  if (["material","all"].includes(task.simulate_failure)) { task.bundle.image_assets.filter(asset=>asset.status!=="succeeded").forEach(asset=>asset.status="failed"); material.status = "failed"; material.message = "模拟图片失败；可重试"; return finalizeTask(task); }
  if(task.bundle.selected_type==="card" || isDemoMode){task.bundle.image_assets.forEach(asset=>asset.status="succeeded");material.status="succeeded";material.message=isDemoMode&&task.bundle.selected_type==="comic"?"授权样例漫画预览已准备":"单图故事卡已完成";return finalizeTask(task);}
  if (!imageApiKey) { material.status = "failed"; material.message = "图片生成暂不可用，请稍后重试。"; return finalizeTask(task); }
  const errors = [];
  for (const [index, asset] of task.bundle.image_assets.entries()) {
    if (task.status === "canceled") return;
    if (asset.status === "succeeded") continue;
    asset.status = "running";
    let success = false, lastError;
    for (let attempt = 0; attempt < 2 && !success; attempt++) try {
      const panelBeats=asset.panels.map(panel=>{
        if(panel.type!=="dialogue")return `第${panel.panel_index}格（无尖角旁白方框）：${JSON.stringify(panel.text)}`;
        const assignment=(task.bundle.visual_context.speech_assignments||[]).find(item=>item.text===panel.text),speaker=String(panel.speaker||assignment?.speaker||"").trim(),visualRole=String(assignment?.visual_role||"").trim();
        return speaker&&speaker!=="无法确认"?`第${panel.panel_index}格（对白气泡，说话人：${speaker}${visualRole?`，画面身份：${visualRole}`:""}）：${JSON.stringify(panel.text)}。本格必须清楚画出说话人“${speaker}”，气泡尖角的唯一终点必须指向“${speaker}”的嘴部附近，绝不能指向听话人、宫女、侍从、旁观者或其他角色`:`第${panel.panel_index}格（说话人无法可靠确认，必须使用无尖角对白框）：${JSON.stringify(panel.text)}。禁止给这个文字框添加指向任何人物的尖角`;
      }).join("；");
      const prompt = `竖版知乎故事分格漫画成品页，第 ${index + 1}/${task.bundle.image_assets.length} 页。用户已选择画风“${asset.visual_style_label}”：${asset.visual_style_prompt}。全项目强制统一渲染规范：${task.bundle.visual_context.render_style}。严禁本页或不同页擅自切换绘画媒介。整张图必须清楚分成 ${asset.panel_count} 个从上到下排列的横向漫画格，每格等宽，以清晰的白色横向间隔线分隔；每格只画一个连续镜头，镜头景别有变化，构图参考成熟的手机竖屏中文条漫。角色视觉圣经（所有格、所有页必须逐项严格复现，不得改变人物的性别呈现、年龄、脸型、发型、服装颜色和关键物件）：${JSON.stringify(task.bundle.visual_context.character_bible)}。固定时空与色彩：${task.bundle.visual_context.setting}；${task.bundle.visual_context.palette}。本页逐格画面、说话人归属与唯一允许出现的文字：${panelBeats}。必须把每句指定中文直接、完整、逐字绘制进对应漫画格；不得增字、漏字、改字、重复、产生乱码或把文字放错格。旁白必须使用无尖角的黑色细边白底方框；只有已明确说话人的 dialogue 才能使用带尖角的小型白底漫画气泡。每一个气泡都先确定说话人，再确定尖角：尖角必须从气泡边缘朝真正说话人的嘴部延伸，终点落在该人物嘴部附近，不能仅仅指向距离气泡最近的人，更不能指向听话人、旁观者、侍从或宫女。若说话人未出现在该格，必须重新构图让说话人入镜；若说话人无法可靠确认，则只能使用无尖角文字框。文字框大小随内容自适应，放在天空、墙面、虚化背景等低信息角落，左右位置可交替，绝对不得遮挡人物脸部、手部、关键动作或关键物件。除上述指定文字外，画面中禁止出现任何其他可读文字、字母、数字、标志或水印；手机、电脑、文件和招牌若入镜，其界面与内容必须虚化或不可读。保持同一角色跨格、跨页可识别；不新增角色，不补写结局或真相。`;
      const signal = AbortSignal.any([AbortSignal.timeout(300000), taskControllers.get(task.id)?.signal].filter(Boolean));
      const response = await fetch(`${imageBaseUrl}/images/generations`, { method:"POST", headers:{ Authorization:`Bearer ${imageApiKey}`, "Content-Type":"application/json" }, body:JSON.stringify({ model:imageModel, prompt, size:"1024x1536", response_format:"b64_json", watermark:false }), signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message || `Seedream 返回 ${response.status}`);
      const data = payload.data?.[0];
      if (data?.b64_json) asset._image_buffer = Buffer.from(data.b64_json, "base64");
      else if (data?.url) { const upstream=await fetch(data.url,{signal:AbortSignal.any([AbortSignal.timeout(30000),taskControllers.get(task.id)?.signal].filter(Boolean))});if(!upstream.ok)throw new Error(`Seedream 图片下载失败（${upstream.status}）`);asset._image_buffer=Buffer.from(await upstream.arrayBuffer()); }
      else throw new Error("Seedream 响应缺少 b64_json 或 url");
      asset._image_file=await saveMedia(task.id,asset.file_name,asset._image_buffer);asset.image_url = `/api/tasks/${task.id}/images/${index}`;asset.text_embedded=true;
      asset.status="succeeded"; success=true; upstreamState.image.verified=true; upstreamState.image.last_error=null;
    } catch (err) { if(task.status==="canceled")return;lastError=err; upstreamState.image.verified=false; upstreamState.image.last_error=err?.message || "未知错误"; }
    if (!success) { asset.status="failed"; errors.push(`${asset.file_name}: ${lastError?.message || "未知错误"}`); }
  }
  if (errors.length) { material.status="failed"; material.message=`${errors.length} 页没有生成成功。已完成页面会保留，重试时只处理失败页。`; }
  else { material.status = "succeeded"; material.message = `${task.bundle.image_assets.length} 张图片已完成`; }
  finalizeTask(task);
}
async function runMusic(task) {
  const music = task.subtasks.find(item => item.id === "music");
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const profile=task.bundle.music_profile;const generated = await callLocalMusic(profile.prompt,profile.negative_prompt,profile.duration,profile.steps,profile.cfg,profile.seed + attempt,taskControllers.get(task.id)?.signal); task.bundle._audio_buffer = generated.buffer; task.bundle._audio_file=await saveMedia(task.id,"bgm.wav",generated.buffer); task.bundle.audio_url = `/api/tasks/${task.id}/audio`; music.status = "succeeded"; music.message = `配乐已生成并完成音频检查${attempt ? "（重试成功）" : ""}`; finalizeTask(task); return; }
    catch { if(task.status==="canceled")return; }
  }
  music.status = "failed"; music.message = "配乐没有生成成功，已自动重试一次。图片不受影响。"; finalizeTask(task);
}
async function callLocalMusic(prompt, negativePrompt, seconds, steps, cfg, seed, cancelSignal) {
  const data = ["sm-music","fp32","same-s",prompt,negativePrompt,seconds,steps,String(seed),cfg,1,1,.92,null,null,0,0,["Auto-play"],"Save to WAV",null,"",1,null,"",1,null,"",1];
  const started = await fetch(`${musicBaseUrl}/gradio_api/call/generate`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({data}), signal:AbortSignal.any([AbortSignal.timeout(10000),cancelSignal].filter(Boolean)) });
  if (!started.ok) throw new Error(`Gradio 提交失败（${started.status}）`); const { event_id: eventId } = await started.json(); if (!eventId) throw new Error("Gradio 未返回 event_id");
  const stream = await fetch(`${musicBaseUrl}/gradio_api/call/generate/${eventId}`, { signal:AbortSignal.any([AbortSignal.timeout(240000),cancelSignal].filter(Boolean)) }); if (!stream.ok) throw new Error(`Gradio 任务失败（${stream.status}）`); const text = await stream.text();
  const matches = [...text.matchAll(/(?:src=\\?"|url\\?"?:\\?")([^"\\]+(?:\.wav|gradio_api\/file=[^"\\]+))/gi)]; if (!matches.length) throw new Error("Gradio 响应中未找到 WAV"); let value = matches.at(-1)[1].replace(/\\u0026/g,"&"); if (!/^https?:/i.test(value)) value = `${musicBaseUrl}/${value.replace(/^\//,"")}`;
  const audio=await fetch(value,{signal:AbortSignal.any([AbortSignal.timeout(30000),cancelSignal].filter(Boolean))});if(!audio.ok)throw new Error(`WAV 下载失败（${audio.status}）`);const buffer=Buffer.from(await audio.arrayBuffer());validateWav(buffer);return {url:value,buffer};
}
function validateWav(buffer){
  if(buffer.length<48||buffer.toString("ascii",0,4)!=="RIFF"||buffer.toString("ascii",8,12)!=="WAVE")throw new Error("音频不是有效 WAV");
  let offset=12,dataOffset=-1,dataSize=0,byteRate=0;while(offset+8<=buffer.length){const name=buffer.toString("ascii",offset,offset+4),size=buffer.readUInt32LE(offset+4);if(name==="fmt ")byteRate=buffer.readUInt32LE(offset+16);if(name==="data"){dataOffset=offset+8;dataSize=Math.min(size,buffer.length-dataOffset);break;}offset+=8+size+(size%2);}
  if(dataOffset<0||!byteRate)throw new Error("WAV 缺少音频数据");const duration=dataSize/byteRate;if(duration<20||duration>45)throw new Error(`音频时长异常（${duration.toFixed(1)} 秒）`);
  let energy=0,clips=0,count=0;const stride=Math.max(2,Math.floor(dataSize/20000/2)*2);for(let i=dataOffset;i+1<dataOffset+dataSize;i+=stride){const sample=buffer.readInt16LE(i)/32768;energy+=sample*sample;if(Math.abs(sample)>.995)clips++;count++;}const rms=Math.sqrt(energy/Math.max(1,count));if(rms<.002)throw new Error("音频接近静音");if(clips/Math.max(1,count)>.08)throw new Error("音频存在严重爆音风险");
}
function finalizeTask(task) {
  if(task.status==="canceled")return persistState();
  const states = task.subtasks.map(item => item.status); if (states.some(s => ["queued","running"].includes(s))) { task.status="running"; task.progress = Math.min(92,Math.round(states.filter(s=>s==="succeeded").length / states.length * 85 + 8)); task.updated_at=Date.now(); persistState(); return; }
  const material = task.subtasks.find(item=>item.id==="material"), music=task.subtasks.find(item=>item.id==="music");
  task.status = material.status === "failed" ? "failed" : music?.status === "failed" ? "partially_failed" : "succeeded"; task.progress=100; task.message = task.status === "succeeded" ? "宣传素材已完成" : task.status === "partially_failed" ? "图片已经完成，配乐没有生成成功。你可以直接使用图片，或单独重试配乐。" : "图片没有生成成功。请重试；已完成的内容会保留。"; task.updated_at=Date.now();taskControllers.delete(task.id);persistState();
}
function publicTask(task) {
  const copy = JSON.parse(JSON.stringify(task, (key, value) => key.startsWith("_") ? undefined : value));
  const project=projects.get(task.project_id);if(!copy.bundle.project_metadata&&project)copy.bundle.project_metadata={title:project.input.title,author:project.input.author,source_url:project.input.source_url};
  delete copy.simulate_failure;delete copy.bundle.audio_source_url;delete copy.bundle.visual_context;delete copy.bundle.poster_design;
  if(copy.bundle.selected_hook_profile){delete copy.bundle.selected_hook_profile.source_refs;for(const line of copy.bundle.selected_hook_profile.selected_lines||[])delete line.source_refs;delete copy.bundle.selected_hook_profile.validation_mode;}
  if(copy.bundle.music_profile)copy.bundle.music_profile={preset_label:copy.bundle.music_profile.preset_label,duration:copy.bundle.music_profile.duration};
  for(const asset of copy.bundle.image_assets||[]){delete asset.adapter_mode;delete asset.visual_style_prompt;for(const panel of asset.panels||[])delete panel.source_refs;}
  return copy;
}
function publicProject(project){
  const analysis=project.analysis||{},content=analysis.content_analysis||{};
  return {analysis:{story_profile:{project_id:analysis.story_profile?.project_id,primary_category:analysis.story_profile?.primary_category},content_analysis:{evidence_pool:(content.evidence_pool||[]).map(item=>({ref_id:item.ref_id,quote:item.quote}))},candidates:(analysis.candidates||[]).map(item=>({candidate_id:item.candidate_id,hook_type:item.hook_type,rendered_text:item.rendered_text,recommendation_reason:item.recommendation_reason,recommended_material:item.recommended_material,lines:item.lines?.map(line=>({type:line.type,speaker:line.speaker||undefined,text:line.text,source_refs:line.source_refs}))})),best_candidate_id:analysis.best_candidate_id},selected_hook_profile:project.selectedHook,recommendation:project.selectedHook?recommendationFor(project.selectedHook.final_text,project.selectedHook.hook_type):null,expires_at:project.expires_at};
}
function imageContentType(buffer){return buffer?.[0]===0x89&&buffer?.[1]===0x50?"image/png":buffer?.[0]===0xff&&buffer?.[1]===0xd8?"image/jpeg":"application/octet-stream";}

async function proxyImage(task, index, res, head = false) {
  const asset = task.bundle.image_assets[Number(index)]; if (!asset) throw error("图片不存在", 404);
  let buffer = asset._image_buffer;
  if (!buffer && asset._image_file) buffer = await readFile(asset._image_file).catch(() => null);
  if (!buffer && asset._image_source_url) { const upstream = await fetch(asset._image_source_url, { signal:AbortSignal.timeout(30000) }); if (!upstream.ok) throw error(`图片读取失败（${upstream.status}）`,502); buffer=Buffer.from(await upstream.arrayBuffer()); }
  if (!buffer) throw error("生成图片文件不可用，请重试视觉物料",404);
  res.writeHead(200,{"Content-Type":imageContentType(buffer),"Content-Length":buffer.length,"Cache-Control":"private, no-store"}); return head ? res.end() : res.end(buffer);
}
async function proxyPreviousImage(task,index,res,head=false){
  const version=task.bundle.image_assets[Number(index)]?.versions?.at(-1);if(!version)throw error("没有可查看的上一版",404);
  if(version._image_file){const buffer=await readFile(version._image_file).catch(()=>null);if(!buffer)throw error("上一版图片文件已经过期",404);res.writeHead(200,{"Content-Type":imageContentType(buffer),"Content-Length":buffer.length,"Cache-Control":"private, no-store"});return head?res.end():res.end(buffer);}
  const colors=(version.colors||[]).filter(value=>/^#[0-9a-f]{6}$/i.test(value)).slice(0,2);if(colors.length<2)throw error("上一版图片文件已经过期",404);
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="1080" height="1440" fill="url(#g)"/></svg>`);
  res.writeHead(200,{"Content-Type":"image/svg+xml; charset=utf-8","Content-Length":svg.length,"Cache-Control":"private, no-store"});return head?res.end():res.end(svg);
}

async function regenerateAsset(task,index,body={}){
  if(task.bundle.selected_type!=="comic")throw error("单图故事卡请使用重新排版或更换背景。",409);
  const asset=task.bundle.image_assets[Number(index)];if(!asset)throw error("没有找到这一页",404);
  asset.versions ||= [];
  const previous={version:asset.versions.length+1,created_at:Date.now(),image_url:asset.image_url||null,css_background:asset.css_background,colors:[...(asset.colors||[])],text_embedded:Boolean(asset.text_embedded),preview_available:Boolean(asset._image_file||asset.colors?.length>=2),_image_file:null};
  if(asset._image_file){const buffer=await readFile(asset._image_file).catch(()=>null);if(buffer){previous._image_file=await saveMedia(task.id,`previous-${index}-${Date.now()}.${extname(asset._image_file).replace(/^\./,"")||"png"}`,buffer);}}
  asset.versions.push(previous);asset.issue={type:String(body.issue_type||"其他问题"),note:String(body.note||"").slice(0,500)};asset.status="queued";delete asset._image_buffer;delete asset.image_url;delete asset.text_embedded;
  if(isDemoMode&&asset.colors?.length){asset.colors=[...asset.colors].reverse();asset.css_background=`linear-gradient(145deg,${asset.colors[0]},${asset.colors[1]})`;}
  const material=task.subtasks.find(item=>item.id==="material");material.status="running";material.message=`正在重新生成第 ${Number(index)+1} 页`;task.status="running";task.progress=70;task.updated_at=Date.now();await persistState();
  runMaterial(task).catch(()=>{material.status="failed";material.message=`第 ${Number(index)+1} 页没有生成成功，请重试。`;finalizeTask(task);});return publicTask(task);
}
async function restoreAssetVersion(task,index){
  const asset=task.bundle.image_assets[Number(index)],version=asset?.versions?.pop();if(!asset||!version)throw error("没有可恢复的上一版",409);
  asset.css_background=version.css_background||asset.css_background;
  if(version._image_file){const buffer=await readFile(version._image_file).catch(()=>null);if(!buffer)throw error("上一版图片文件已经过期",404);asset._image_file=await saveMedia(task.id,asset.file_name,buffer);asset.image_url=`/api/tasks/${task.id}/images/${index}`;asset.text_embedded=Boolean(version.text_embedded);}
  else{delete asset._image_file;delete asset._image_buffer;delete asset.image_url;delete asset.text_embedded;}
  asset.status="succeeded";await persistState();return publicTask(task);
}

function sendAudioBuffer(buffer,res,req,contentType="audio/wav"){
  const common={"Content-Type":contentType,"Accept-Ranges":"bytes","Cache-Control":"private, no-store"};
  const range=String(req.headers.range||"").match(/^bytes=(\d*)-(\d*)$/);
  if(range){
    let start=range[1]?Number(range[1]):0,end=range[2]?Number(range[2]):buffer.length-1;
    if(!range[1]&&range[2]){const suffix=Number(range[2]);start=Math.max(0,buffer.length-suffix);end=buffer.length-1;}
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||start>=buffer.length){res.writeHead(416,{...common,"Content-Range":`bytes */${buffer.length}`});return res.end();}
    end=Math.min(end,buffer.length-1);const chunk=buffer.subarray(start,end+1);
    res.writeHead(206,{...common,"Content-Length":chunk.length,"Content-Range":`bytes ${start}-${end}/${buffer.length}`});
    return req.method==="HEAD"?res.end():res.end(chunk);
  }
  res.writeHead(200,{...common,"Content-Length":buffer.length});return req.method==="HEAD"?res.end():res.end(buffer);
}
async function proxyAudio(task, res, req) {
  if(task.bundle._audio_buffer)return sendAudioBuffer(task.bundle._audio_buffer,res,req);
  if(task.bundle._audio_file){const buffer=await readFile(task.bundle._audio_file).catch(()=>null);if(buffer)return sendAudioBuffer(buffer,res,req);}
  if (!task.bundle.audio_source_url) throw error("音频不可用", 404);
  const upstream = await fetch(task.bundle.audio_source_url, { signal: AbortSignal.timeout(30000) }); if (!upstream.ok) throw error(`音频读取失败（${upstream.status}）`, 502);
  const buffer = Buffer.from(await upstream.arrayBuffer()); return sendAudioBuffer(buffer,res,req,upstream.headers.get("content-type")||"audio/wav");
}
async function savePreparedPackage(task,req){
  const buffer=await readBinary(req);
  let eocd=-1;for(let offset=buffer.length-22;offset>=Math.max(0,buffer.length-65557);offset--)if(buffer.readUInt32LE(offset)===0x06054b50){eocd=offset;break;}
  if(buffer.length<30||buffer.readUInt32LE(0)!==0x04034b50||eocd<0)throw error("发布包不是有效 ZIP",400);
  task.bundle._package_file=await saveMedia(task.id,"publish-package.zip",buffer);task.bundle.package_size=buffer.length;await persistState();
  return {download_url:`/api/tasks/${task.id}/package`,size:buffer.length};
}
async function servePreparedPackage(task,res,head=false){
  const buffer=task.bundle._package_file?await readFile(task.bundle._package_file).catch(()=>null):null;
  if(!buffer)throw error("发布包尚未准备或文件已丢失",404);
  res.writeHead(200,{"Content-Type":"application/zip","Content-Length":buffer.length,"Content-Disposition":'attachment; filename="zhihu-story-package.zip"',"Cache-Control":"private, no-store"});
  return head?res.end():res.end(buffer);
}
function crc32(buffer){let crc=-1;for(const byte of buffer){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(0xedb88320&-(crc&1));}return(crc^-1)>>>0;}
function u16(value){const out=Buffer.alloc(2);out.writeUInt16LE(value);return out;}
function u32(value){const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;}
async function saveFinalImage(task,index,req){const asset=task.bundle.image_assets[Number(index)];if(!asset)throw error("没有找到这张图片",404);const buffer=await readBinary(req,12*1024*1024);if(buffer.length<8||buffer[0]!==0x89||buffer[1]!==0x50||buffer[2]!==0x4e||buffer[3]!==0x47)throw error("最终图片必须是 PNG",400);asset._final_file=await saveMedia(task.id,`final-${String(Number(index)+1).padStart(2,"0")}.png`,buffer);await persistState();return{saved:true};}
async function streamPublishPackage(project,task,res){
  const entries=[];
  for(const [index,asset]of task.bundle.image_assets.entries()){const buffer=asset._final_file?await readFile(asset._final_file).catch(()=>null):null;if(!buffer)throw error(`第 ${index+1} 张最终图片尚未准备`,409);entries.push({name:`images/${String(index+1).padStart(2,"0")}.png`,buffer});}
  const music=task.subtasks.find(item=>item.id==="music");if(music?.status==="succeeded"&&task.bundle._audio_file){const buffer=await readFile(task.bundle._audio_file).catch(()=>null);if(buffer)entries.push({name:"audio/bgm.wav",buffer});}
  const metadata=task.bundle.project_metadata,materialType=task.bundle.selected_type==="comic"?"连续漫画":"单图故事卡",imageFiles=entries.filter(item=>item.name.startsWith("images/")).map(item=>item.name),includesMusic=entries.some(item=>item.name==="audio/bgm.wav");
  const text=value=>Buffer.from(value,"utf8");
  entries.push({name:"传播文案.txt",buffer:text(task.bundle.selected_hook_profile.final_text)});
  entries.push({name:"发布说明.txt",buffer:text(`《${metadata.title}》\n作者署名：${metadata.author}\n知乎原作：${metadata.source_url}\n素材类型：${materialType}\n图片由 AI 辅助生成，请在发布前由作者复核。`)});
  entries.push({name:"manifest.json",buffer:text(JSON.stringify({product_version:"1.1.0",exported_at:new Date().toISOString(),title:metadata.title,author:metadata.author,source_url:metadata.source_url,material_type:materialType,image_files:imageFiles,includes_music:includesMusic,ai_assisted_notice:"图片由 AI 辅助生成，请在发布前由作者复核。"},null,2))});
  res.writeHead(200,{"Content-Type":"application/zip","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(`${metadata.title}-宣传素材.zip`)}`,"Cache-Control":"private, no-store"});
  let offset=0;const central=[];
  for(const entry of entries){const name=Buffer.from(entry.name,"utf8"),crc=crc32(entry.buffer),local=Buffer.concat([u32(0x04034b50),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(crc),u32(entry.buffer.length),u32(entry.buffer.length),u16(name.length),u16(0),name]);res.write(local);res.write(entry.buffer);central.push(Buffer.concat([u32(0x02014b50),u16(20),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(crc),u32(entry.buffer.length),u32(entry.buffer.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));offset+=local.length+entry.buffer.length;}
  const centralSize=central.reduce((sum,item)=>sum+item.length,0);for(const item of central)res.write(item);res.end(Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(centralSize),u32(offset),u16(0)]));
}
async function serveStatic(pathname, res, head = false) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""), filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) throw new Error("Invalid path"); const info = await stat(filePath); if (!info.isFile()) throw new Error("Not a file");
  res.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream", "Content-Length": info.size }); if (head) return res.end(); res.end(await readFile(filePath));
}
async function musicReachable() { try { const response = await fetch(`${musicBaseUrl}/config`, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; } }

await restoreState();
await cleanupExpired();
const cleanupTimer=setInterval(()=>cleanupExpired().catch(err=>console.error(`过期数据清理失败：${err.message}`)),60*60*1000);cleanupTimer.unref();

const httpServer=createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"), pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok:true, mode:appMode, services:{ text:isDemoMode||textApiKey?(isDemoMode?"demo":"available"):"unavailable", image:isDemoMode||imageApiKey?(isDemoMode?"demo":"available"):"unavailable", music:await musicReachable()?"available":"unavailable" }, retention_hours:retentionMs/3_600_000, limits:{body_non_whitespace:50000} });
    const expireTestMatch=pathname.match(/^\/api\/test\/projects\/([^/]+)\/expire$/);if(req.method==="POST"&&expireTestMatch&&isTestMode){const project=projects.get(expireTestMatch[1]);if(!project)throw error("测试作品不存在",404);project.expires_at=Date.now()-1;await cleanupExpired();return sendJson(res,200,{expired:true});}
    if (req.method === "GET" && pathname === "/api/samples") { const samples=await loadSamples(); return sendJson(res,200,{samples:samples.filter(sampleAllowedForDemo).map(({work_id,title,labels,data_no,author_name,source_url})=>({work_id,title,labels,data_no,author_name,source_url}))}); }
    const sampleMatch = pathname.match(/^\/api\/samples\/([^/]+)$/); if (req.method === "GET" && sampleMatch) { const sample=(await loadSamples()).find(item=>String(item.work_id)===sampleMatch[1]&&sampleAllowedForDemo(item)); if(!sample)throw error("授权样例不存在",404); return sendJson(res,200,{work_id:sample.work_id,title:sample.title,author_name:sample.author_name,source_url:sample.source_url||"",labels:sample.labels,body:sample.body}); }
    if (req.method === "POST" && pathname === "/api/projects/analyze") return sendJson(res, 200, await analyzeProject(await readJson(req)));
    const projectMatch=pathname.match(/^\/api\/projects\/([^/]+)$/);if(req.method==="GET"&&projectMatch){const project=projects.get(projectMatch[1]);if(!project)throw error("作品不存在或已经过期",404);return sendJson(res,200,publicProject(project));}
    if(req.method==="PATCH"&&projectMatch){const project=projects.get(projectMatch[1]);if(!project)throw error("作品不存在或已经过期",404);const body=await readJson(req),sourceUrl=String(body.source_url||"").trim();if(sourceUrl&&!/^https:\/\/(?:www\.)?zhihu\.com\//i.test(sourceUrl))throw error("请输入有效的知乎原作链接，例如 https://www.zhihu.com/...",400);project.input.title=String(body.title||project.input.title).trim();project.input.author=String(body.author||project.input.author).trim();project.input.source_url=sourceUrl;project.updated_at=Date.now();for(const taskId of project.bundles||[]){const task=tasks.get(taskId);if(task)task.bundle.project_metadata={title:project.input.title,author:project.input.author,source_url:sourceUrl};}await persistState();return sendJson(res,200,{saved:true});}
    const selectMatch = pathname.match(/^\/api\/projects\/([^/]+)\/select-hook$/); if (req.method === "POST" && selectMatch) { const project=projects.get(selectMatch[1]); if(!project)throw error("项目不存在或服务已重启，请重新分析",404); const selected=await selectHook(project,await readJson(req)); if(selected.validation_status!=="passed")throw error("钩子校验未通过",422,selected.issues); const recommendation=selected.recommendation; delete selected.recommendation; return sendJson(res,200,{selected_hook_profile:selected,material_recommendation:recommendation}); }
    const regenerateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/hooks\/regenerate-one$/); if(req.method==="POST"&&regenerateMatch){const project=projects.get(regenerateMatch[1]);if(!project)throw error("项目不存在或服务已重启，请重新分析",404);return sendJson(res,200,await regenerateOne(project,await readJson(req)));}
    const selectedExportMatch = pathname.match(/^\/api\/projects\/([^/]+)\/hooks\/selected\/export$/); if(req.method==="GET"&&selectedExportMatch){const project=projects.get(selectedExportMatch[1]);if(!project)throw error("作品不存在或已经过期",404);if(project.selectedHook?.validation_status!=="passed")throw error("尚未确认传播文案",409);const text=project.selectedHook.final_text;res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent("传播文案.txt")}`,"Content-Length":Buffer.byteLength(text)});return res.end(text);}
    if (req.method === "GET" && pathname === "/api/backgrounds") { const project=projects.get(url.searchParams.get("project_id")); const category=url.searchParams.get("category"); return sendJson(res,200,{category,backgrounds:backgroundPresets(category,project?.input)}); }
    const generateMatch=pathname.match(/^\/api\/projects\/([^/]+)\/generate$/); if(req.method==="POST"&&generateMatch){const project=projects.get(generateMatch[1]);if(!project)throw error("项目不存在或服务已重启，请重新分析",404);return sendJson(res,202,await createTask(project,await readJson(req)));}
    const deleteProjectMatch=pathname.match(/^\/api\/projects\/([^/]+)$/);if(req.method==="DELETE"&&deleteProjectMatch){if(!await deleteProject(deleteProjectMatch[1]))throw error("作品不存在或已经删除",404);return sendJson(res,200,{deleted:true});}
    const projectExportMatch=pathname.match(/^\/api\/projects\/([^/]+)\/export$/); if(req.method==="GET"&&projectExportMatch){const project=projects.get(projectExportMatch[1]);if(!project)throw error("项目不存在或服务已重启，请重新分析",404);if(!/^https:\/\/(?:www\.)?zhihu\.com\//i.test(project.input.source_url||""))throw error("缺少有效知乎原作链接，正式导出已阻止",409);const requestedTaskId=url.searchParams.get("task_id");const task=requestedTaskId?tasks.get(requestedTaskId):[...project.bundles].reverse().map(id=>tasks.get(id)).find(item=>item&&["succeeded","partially_failed"].includes(item.status)&&item.subtasks.find(sub=>sub.id==="material")?.status==="succeeded");if(!task||task.project_id!==project.analysis.story_profile.project_id||!["succeeded","partially_failed"].includes(task.status)||task.subtasks.find(sub=>sub.id==="material")?.status!=="succeeded")throw error("指定任务不属于当前项目或尚无可导出的视觉物料",409);return sendJson(res,200,{download_url:`/api/projects/${projectExportMatch[1]}/package?task_id=${task.id}`,export_mode:"server_stream",omitted_assets:task.subtasks.find(sub=>sub.id==="music")?.status==="succeeded"?[]:["audio/bgm.wav"]});}
    const streamPackageMatch=pathname.match(/^\/api\/projects\/([^/]+)\/package$/);if(req.method==="GET"&&streamPackageMatch){const project=projects.get(streamPackageMatch[1]);if(!project)throw error("作品不存在或已经过期",404);if(!/^https:\/\/(?:www\.)?zhihu\.com\//i.test(project.input.source_url||""))throw error("请填写有效的知乎原作链接后再导出发布素材。",409);const task=tasks.get(url.searchParams.get("task_id"));if(!task||task.project_id!==streamPackageMatch[1])throw error("没有找到可导出的宣传素材",409);return streamPublishPackage(project,task,res);}
    const packageMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/package$/); if(packageMatch){const task=tasks.get(packageMatch[1]);if(!task)throw error("任务不存在",404);if(req.method==="POST")return sendJson(res,201,await savePreparedPackage(task,req));if(["GET","HEAD"].includes(req.method))return servePreparedPackage(task,res,req.method==="HEAD");}
    const finalImageMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/final-images\/(\d+)$/);if(req.method==="POST"&&finalImageMatch){const task=tasks.get(finalImageMatch[1]);if(!task)throw error("生成记录不存在",404);return sendJson(res,201,await saveFinalImage(task,finalImageMatch[2],req));}
    const taskMatch=pathname.match(/^\/api\/tasks\/([^/]+)$/); if(req.method==="GET"&&taskMatch){const task=tasks.get(taskMatch[1]);if(!task)throw error("任务不存在",404);return sendJson(res,200,publicTask(task));}
    const retryMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/); if(req.method==="POST"&&retryMatch){const task=tasks.get(retryMatch[1]);if(!task)throw error("任务不存在",404);if(!["failed","partially_failed"].includes(task.status))throw error("当前任务没有可重试失败项",409);task.simulate_failure="";task.attempt+=1;startTask(task,true);return sendJson(res,202,publicTask(task));}
    const cancelMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);if(req.method==="POST"&&cancelMatch){const task=tasks.get(cancelMatch[1]);if(!task)throw error("任务不存在",404);if(!["queued","running"].includes(task.status))throw error("当前生成无法取消",409);taskControllers.get(task.id)?.abort();taskControllers.delete(task.id);task.status="canceled";task.progress=Math.min(99,task.progress);task.message="已取消";task.updated_at=Date.now();for(const subtask of task.subtasks)if(["queued","running"].includes(subtask.status)){subtask.status="canceled";subtask.message="已取消";}await persistState();return sendJson(res,200,publicTask(task));}
    const regenerateAssetMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/assets\/(\d+)\/regenerate$/);if(req.method==="POST"&&regenerateAssetMatch){const task=tasks.get(regenerateAssetMatch[1]);if(!task)throw error("生成记录不存在",404);return sendJson(res,202,await regenerateAsset(task,regenerateAssetMatch[2],await readJson(req)));}
    const restoreAssetMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/assets\/(\d+)\/restore$/);if(req.method==="POST"&&restoreAssetMatch){const task=tasks.get(restoreAssetMatch[1]);if(!task)throw error("生成记录不存在",404);return sendJson(res,200,await restoreAssetVersion(task,restoreAssetMatch[2]));}
    const audioMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/audio$/); if(["GET","HEAD"].includes(req.method)&&audioMatch){const task=tasks.get(audioMatch[1]);if(!task)throw error("任务不存在",404);return proxyAudio(task,res,req);}
    const imageMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/images\/(\d+)$/); if(["GET","HEAD"].includes(req.method)&&imageMatch){const task=tasks.get(imageMatch[1]);if(!task)throw error("任务不存在",404);return proxyImage(task,imageMatch[2],res,req.method==="HEAD");}
    const previousImageMatch=pathname.match(/^\/api\/tasks\/([^/]+)\/images\/(\d+)\/previous$/);if(["GET","HEAD"].includes(req.method)&&previousImageMatch){const task=tasks.get(previousImageMatch[1]);if(!task)throw error("生成记录不存在",404);return proxyPreviousImage(task,previousImageMatch[2],res,req.method==="HEAD");}
    if (!["GET","HEAD"].includes(req.method)) return sendJson(res,405,{error:"Method not allowed"}); await serveStatic(pathname,res,req.method==="HEAD");
  } catch (err) { if(pathname.startsWith("/api/")){const status=err.statusCode||500,errorId=randomUUID().slice(0,8);if(status>=500)console.error(`[${errorId}] ${err?.stack||err}`);return sendJson(res,status,status>=500?{error:`生成没有完成。请重试；如果问题持续出现，请提供错误编号 ${errorId}。`,error_id:errorId}:{error:err.message||"请求没有完成，请检查后重试。",details:err.details});}res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Not found"); }
});
httpServer.requestTimeout=20*60*1000;
httpServer.headersTimeout=20*60*1000+5000;
httpServer.listen(port,"127.0.0.1",()=>{console.log(`Zhihu Story Workbench: http://127.0.0.1:${port}`);console.log(`Mode: ${appMode}; data retention: ${retentionMs/3_600_000} hours`);});
