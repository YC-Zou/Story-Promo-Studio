const STORAGE_KEY = "zhihu-story-workbench-v12";
const LEGACY_STORAGE_KEYS=["zhihu-story-workbench-v11"];
const MAX_BODY = 50000;
const TYPE_LABELS = {
  relationship_tension: "关系冲突",
  abnormal_setting: "异常设定",
  identity_contrast: "身份反差",
  crisis_choice: "危机选择",
  emotional_scene: "情绪场景",
};
const STATUS_LABELS = {
  queued: "等待开始", preparing:"正在准备画面", running: "正在生成",
  generating_material:"正在生成图片",generating_music:"正在生成配乐",succeeded: "已完成",
  partially_failed: "图片已完成，配乐未完成", failed: "生成失败",canceled:"已取消",
};
const PAGE_ORDER = ["input", "analysis", "hooks", "action", "style", "background", "progress", "result"];
const STEP_ORDER = ["input", "hooks", "action", "progress", "result"];
const PAGE_STEP = {input:"input",analysis:"input",hooks:"hooks",action:"action",style:"action",background:"action",progress:"progress",result:"result"};
const COMIC_STYLES = [
  { id:"polished-campus", name:"精致校园", sample:"参考 1", desc:"细腻半写实人物、明亮校园光影、清晰分镜", colors:["#9ccff5","#f5d8e5"] },
  { id:"clear-anime", name:"清透日漫", sample:"参考 2", desc:"轻盈线稿、淡彩上色、富有动势的斜切分格", colors:["#dff4f4","#f7e8c8"] },
  { id:"watercolor-youth", name:"水彩青春", sample:"参考 3", desc:"纸张水彩质感、柔和留白、抒情氛围", colors:["#b9dbea","#f5eee5"] },
  { id:"cinematic-noir", name:"冷调电影", sample:"参考 4", desc:"低饱和蓝灰、电影镜头、克制写实情绪", colors:["#27354d","#8b91a2"] },
  { id:"dark-mystery", name:"暗黑怪谈", sample:"参考 5", desc:"深色粗线、怪诞场景、强悬念叙事", colors:["#1c2529","#766251"] },
];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = value => JSON.parse(JSON.stringify(value));
const blankState = () => ({
  page: "input",
  project: { id: "", title: "", author: "", sourceUrl: "", authorized: false, body: "", labels: [], sampleId:"" },
  analysis: null,
  selectedCandidateId: "",
  hookDraft: "",
  hookDirty: true,
  selectedHook: null,
  recommendation: null,
  materialType: "",
  comicStyleId: "",
  backgrounds: [],
  backgroundId: "",
  backgroundFilter: "all",
  posterDesign: null,
  musicEnabled:false,
  task: null,
  history: [],
});
let migratedLegacy=false;
let state = loadState();
if(migratedLegacy)saveState();
let health = null;
let pollTimer = null;
let pollAttempt = 0;
let audioServerUrl = "";
let audioContext = null;
let audioSource = null;
let simulatedFailure = "";
let analysisTimer = null;
let analysisStartedAt = 0;
let videoObjectUrl = "";
let assetObjectUrls = [];
let resultRefreshPending = false;

function loadState() {
  const sources=[STORAGE_KEY,...LEGACY_STORAGE_KEYS].flatMap(key=>[[key,sessionStorage.getItem(key)],[key,localStorage.getItem(key)]]);
  for (const [key,raw] of sources) try {
    const value = JSON.parse(raw);
    if (value?.project) {
      if(key!==STORAGE_KEY){migratedLegacy=true;sessionStorage.removeItem(key);localStorage.removeItem(key);}
      const restored = { ...blankState(), ...value };
      const projectId = restored.project?.id || "";
      restored.history = (restored.history || []).filter(item => !projectId || item.project_id === projectId);
      if (restored.task && projectId && restored.task.project_id !== projectId) restored.task = null;
      if (!restored.task && ["progress", "result"].includes(restored.page)) restored.page = restored.selectedHook ? "action" : restored.analysis ? "hooks" : "input";
      return restored;
    }
  } catch {}
  return blankState();
}

function saveState() {
  const persisted=clone(state);
  persisted.project.body="";
  persisted.analysis=null;
  persisted.hookDraft="";
  const taskSummary=task=>task?{id:task.id,project_id:task.project_id,status:task.status,bundle:{selected_type:task.bundle?.selected_type}}:null;
  persisted.task=taskSummary(persisted.task);
  persisted.history=(persisted.history||[]).slice(-4).map(taskSummary).filter(Boolean);
  try{sessionStorage.setItem(STORAGE_KEY,JSON.stringify(persisted));}catch{}
  const durable=clone(persisted);if(durable.posterDesign)delete durable.posterDesign.previewDataUrl;
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(durable));}catch{}
}

function countChars(text = "") { return String(text).replace(/[\s]/g, "").length; }
function stripPosterPunctuation(text = "") { return String(text).replace(/[，。！？；：、,.!?;:"“”‘’（）()【】《》〈〉—…·~～\-]/gu, "").trim(); }
function groupShortLines(lines, maxGroups = 6) {
  let parts = (lines || []).flatMap(line => String(line.text || "").match(/[^。！？!?；;，,：:\n]+[。！？!?；;，,：:]?|\n+/g) || [String(line.text || "")]).filter(part => part && !/^\n+$/.test(part));
  while (parts.length > maxGroups) {
    let best = 0;
    for (let i = 1; i < parts.length - 1; i++) if (countChars(parts[i]) + countChars(parts[i + 1]) < countChars(parts[best]) + countChars(parts[best + 1])) best = i;
    parts.splice(best, 2, `${parts[best]}${parts[best + 1]}`);
  }
  if (parts.length === 1 && countChars(parts[0]) >= 2) { const chars = [...parts[0]], cut = Math.ceil(chars.length / 2); parts = [chars.slice(0, cut).join(""), chars.slice(cut).join("")]; }
  return parts.map(text => text.trim()).filter(Boolean);
}
function escapeHtml(value = "") {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}
function escapeAttr(value = "") { return escapeHtml(value).replaceAll('"', "&quot;"); }
function toast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), 4500);
}
function setBusy(button, busy, busyText) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}
function api(path, options = {}) {
  return fetch(path, options).then(async response => {
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("json") ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) throw Object.assign(new Error(payload?.error || `请求失败（${response.status}）`), { status: response.status, details: payload?.details });
    return payload;
  });
}

async function init() {
  bindEvents();
  hydrateInputs();
  await Promise.allSettled([checkHealth(), loadSamples(), restoreProject(), restoreTask()]);
  renderAll();
  const startup = new URLSearchParams(location.search);
  if (startup.get("start_card") === "1") {
    window.history.replaceState(null, "", location.pathname);
    if (state.posterDesign?.backgroundId === state.backgroundId && state.posterDesign?.previewDataUrl) {
      showPreflight("card");
      return;
    }
    state.page = "background";
    saveState();
    renderAll();
    toast("没有找到已保存的单图故事卡，请先保存定稿");
  }
  if (state.task && ["queued", "running"].includes(state.task.status)) resumeTask();
}

async function restoreProject(){
  if(!state.project.id||state.analysis)return;
  try{const restored=await api(`/api/projects/${encodeURIComponent(state.project.id)}`);state.analysis=restored.analysis;if(!state.selectedHook&&restored.selected_hook_profile)state.selectedHook=restored.selected_hook_profile;if(!state.recommendation&&restored.recommendation)state.recommendation=restored.recommendation;if(state.page==="hooks"&&!state.hookDraft){const selected=state.analysis.candidates.find(item=>item.candidate_id===state.selectedCandidateId)||state.analysis.candidates[0];state.hookDraft=selected?.rendered_text||"";}}
  catch{state.project.id="";state.task=null;state.analysis=null;state.page="input";saveState();}
}
async function restoreTask(){
  if(!state.task?.id)return;
  try{state.task=await api(`/api/tasks/${encodeURIComponent(state.task.id)}`);saveState();}
  catch{state.task=null;if(["progress","result"].includes(state.page))state.page=state.selectedHook?"action":"input";saveState();}
}

async function checkHealth() {
  try {
    health = await api("/api/health");
    const el = $("#serviceState");
    el.className = `service-state ${health.mode === "demo" || health.mode === "test" ? "is-demo" : "is-live"}`;
    const textState=health.mode === "demo" || health.mode === "test" ? "演示模式" : !health.services ? "暂时无法确认服务状态" : health.services.text === "available" && health.services.image === "available" ? "生成服务已配置" : health.services.text !== "available" ? "文字生成暂不可用" : "图片生成暂不可用";
    const music=health.services?.music === "available" ? "" : " · 配乐暂不可用，不影响图片生成";
    el.querySelector("span").textContent = `${textState}${music}`;
    $("#serviceDetailsText").textContent=`当前为${health.mode === "demo" || health.mode === "test" ? "演示模式，仅使用固定授权样例和已审核输出" : "真实生成模式"}。正文和生成文件默认保存 ${health.retention_hours || 24} 小时。`;
  } catch {
    $("#serviceState").querySelector("span").textContent = "暂时无法确认服务状态";
  }
}

async function loadSamples() {
  const result = await api("/api/samples");
  const select = $("#sampleSelect");
  result.samples.forEach(sample => {
    const option = document.createElement("option");
    option.value = sample.work_id;
    option.textContent = `${sample.title} · ${(sample.labels || []).slice(0, 3).join("/")}`;
    select.append(option);
  });
}

function hydrateInputs() {
  $("#titleInput").value = state.project.title || "";
  $("#authorInput").value = state.project.author || "";
  $("#sourceUrlInput").value = state.project.sourceUrl || "";
  $("#authorizationInput").checked = Boolean(state.project.authorized);
  $("#bodyInput").value = state.project.body || "";
  $("#deleteProjectBtn").hidden=!state.project.id;
  updateBodyCount();
}

function syncProjectFromInputs() {
  state.project.title = $("#titleInput").value.trim();
  state.project.author = $("#authorInput").value.trim();
  state.project.sourceUrl = $("#sourceUrlInput").value.trim();
  state.project.authorized = $("#authorizationInput").checked;
  state.project.body = $("#bodyInput").value;
  validateSourceUrl(false);
  saveState();
}

function updateBodyCount() {
  const count = countChars($("#bodyInput").value);
  const el = $("#charCount");
  el.textContent = `${count.toLocaleString("zh-CN")} / ${MAX_BODY.toLocaleString("zh-CN")}`;
  el.classList.toggle("is-error", count > MAX_BODY);
  $("#inputError").textContent = count > MAX_BODY ? `正文超出上限 ${count - MAX_BODY} 个字符，请删减后再生成。我们不会截断正文。` : "";
}

function renderAll() {
  showPage(state.page, false);
  renderHooks();
  renderAction();
  renderStyles();
  renderBackgrounds();
  if (state.task) renderTask();
  if (state.page === "result") renderResult();
}

function showPage(page, persist = true) {
  if (!PAGE_ORDER.includes(page)) page = "input";
  state.page = page;
  $$('[data-page]').forEach(section => { section.hidden = section.dataset.page !== page; });
  const currentStep=PAGE_STEP[page],current = STEP_ORDER.indexOf(currentStep);
  const currentLabel=$(`[data-step="${currentStep}"] span`)?.textContent||"导入故事";$("#mobileStepLabel").textContent=`第 ${current+1} 步，共 5 步：${currentLabel}`;
  $$('[data-step]').forEach(button => {
    const index = STEP_ORDER.indexOf(button.dataset.step);
    button.classList.toggle("is-current", button.dataset.step === currentStep);
    button.classList.toggle("is-complete", index < current);
    button.disabled = !canVisit(button.dataset.step);
  });
  if (persist) saveState();
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  window.dispatchEvent(new CustomEvent("story-state",{detail:{page,task:state.task}}));
}

function canVisit(page) {
  if (page === "input") return true;
  if (page === "analysis") return state.page === "analysis";
  if (page === "hooks") return Boolean(state.analysis);
  if (page === "action") return Boolean(state.selectedHook);
  if (page === "style") return Boolean(state.selectedHook && state.materialType === "comic");
  if (page === "background") return Boolean(state.selectedHook && state.materialType === "card" && state.backgrounds.length);
  if (page === "progress") return Boolean(state.task);
  if (page === "result") return Boolean(state.task && ["succeeded", "partially_failed"].includes(state.task.status));
  return false;
}

function validateInput() {
  syncProjectFromInputs();
  const errors = [];
  if (!state.project.title) errors.push("请填写作品名。");
  if (!state.project.author) errors.push("请填写导出素材中使用的作者署名。");
  const count = countChars(state.project.body);
  if (!count) errors.push("请粘贴正文或上传文件。");
  if (count > MAX_BODY) errors.push(`正文超出上限 ${count - MAX_BODY} 个字符，请删减后再生成。我们不会截断正文。`);
  if (!state.project.authorized) errors.push("请确认你有权将这篇作品用于 AI 生成和站外宣传。");
  if(state.project.sourceUrl&&!validateSourceUrl(true))errors.push("请输入有效的知乎原作链接，例如 https://www.zhihu.com/...");
  $("#inputError").textContent = errors.join(" ");
  return errors.length === 0;
}

function validateSourceUrl(show=true){
  const value=$("#sourceUrlInput").value.trim(),valid=!value||/^https:\/\/(?:www\.)?zhihu\.com\//i.test(value);
  if(show||value)$("#sourceUrlError").textContent=valid?"":"请输入有效的知乎原作链接，例如 https://www.zhihu.com/...";
  return valid;
}

async function analyze() {
  if (!validateInput()) return;
  const button = $("#analyzeBtn");
  setBusy(button, true, "正在阅读故事…");
  analysisStartedAt = Date.now();
  showPage("analysis");
  updateAnalysisProgress();
  try {
    const result = await api("/api/projects/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: state.project.title, author: state.project.author, source_url: state.project.sourceUrl, authorized: state.project.authorized, body: state.project.body, labels: state.project.labels, sample_id:state.project.sampleId }),
    });
    state.project.id = result.story_profile.project_id;
    state.analysis = result;
    state.selectedCandidateId = result.best_candidate_id || result.candidates?.[0]?.candidate_id || "";
    const selected = result.candidates.find(item => item.candidate_id === state.selectedCandidateId) || result.candidates[0];
    state.hookDraft = selected?.rendered_text || "";
    state.hookDirty = true;
    state.selectedHook = null;
    state.recommendation = null;
    state.task = null;
    clearInterval(analysisTimer);
    $("#analysisBar").style.width = "100%";
    $("#analysisPercent").textContent = "文案已生成";
    $("#analysisPhase").textContent = "传播文案已准备好，正在打开…";
    saveState();
    renderHooks();
    await new Promise(resolve => setTimeout(resolve, 450));
    showPage("hooks");
    window.dispatchEvent(new CustomEvent("story-complete",{detail:{key:state.project.id,type:"hook-done"}}));
    toast(`已准备 ${result.candidates.length} 个传播角度`);
  } catch (error) {
    $("#inputError").textContent = error.status===429?"当前生成请求较多，请稍后重试。正文仍保留在本页。":error instanceof TypeError?"未能获取生成结果。当前页面中的正文仍保留，请检查网络后重试。":error.message;
    showPage("input");
  } finally { clearInterval(analysisTimer); setBusy(button, false); }
}

function updateAnalysisProgress() {
  clearInterval(analysisTimer);
  const tick = () => {
    const seconds = (Date.now() - analysisStartedAt) / 1000;
    const percent = Math.min(94, Math.round(8 + 86 * (1 - Math.exp(-seconds / 58))));
    const phases = percent < 30 ? "正在阅读故事正文…" : percent < 60 ? "正在梳理人物与情节…" : "正在准备三种传播角度…";
    $("#analysisBar").style.width = `${percent}%`;
    $("#analysisPercent").textContent = "生成中";
    $("#analysisPhase").textContent = "正在理解故事并准备传播文案";
  };
  tick(); analysisTimer = setInterval(tick, 800);
}

function renderHooks() {
  if (!state.analysis) return;
  $("#analysisSummary").innerHTML = `<span><b>为你准备了 ${state.analysis.candidates.length} 个传播角度</b></span><span>选择后仍可编辑，确认前会进行内容检查。</span>`;
  const evidence=state.analysis.content_analysis?.evidence_pool||[];
  $("#hookGrid").innerHTML = state.analysis.candidates.map((candidate,index) => {
    const selected = candidate.candidate_id === state.selectedCandidateId;
    const refs=[...new Set((candidate.lines||[]).flatMap(line=>line.source_refs||[]))],quotes=refs.map(ref=>evidence.find(item=>item.ref_id===ref)?.quote).filter(Boolean);
    return `<article class="hook-card${selected ? " is-selected" : ""}"><header><span class="hook-type">${escapeHtml(TYPE_LABELS[candidate.hook_type] || "传播角度")}</span><small>${selected ? "✓ 当前选择" : `方案 ${index+1}`}</small></header><pre>${escapeHtml(candidate.rendered_text)}</pre><p>${escapeHtml(candidate.recommendation_reason)}</p><strong>${candidate.recommended_material === "comic" ? "适合连续漫画" : "适合单图故事卡"}</strong><details><summary>查看原文依据</summary>${quotes.length?`<ul>${quotes.map(quote=>`<li>${escapeHtml(quote)}</li>`).join("")}</ul>`:"<p>暂时无法定位这句话的原文依据。请编辑或选择其他版本。</p>"}</details><button class="button ${selected?"ghost":"primary"} full" data-candidate="${escapeAttr(candidate.candidate_id)}" type="button">${selected?"已选择":"选择这版"}</button></article>`;
  }).join("");
  $$('[data-candidate]').forEach(button => button.onclick = () => selectCandidate(button.dataset.candidate));
  $("#hookEditor").value = state.hookDraft || "";
  updateHookLength();
  renderValidation();
}

function selectCandidate(id) {
  const candidate = state.analysis.candidates.find(item => item.candidate_id === id);
  if (!candidate) return;
  state.selectedCandidateId = id;
  state.hookDraft = candidate.rendered_text;
  state.hookDirty = true;
  saveState();
  renderHooks();
}

function updateHookLength() {
  const count = countChars($("#hookEditor").value);
  $("#hookLength").textContent = `${count} / 300`;
}

function renderValidation(result = null) {
  const panel = $("#validationPanel");
  panel.className = "validation";
  if (result?.validation_status === "passed") {
    panel.classList.add("is-valid");
    panel.innerHTML = `<b>检查通过，可以继续制作宣传素材。</b>`;
  } else if (result?.issues?.length) {
    panel.classList.add("is-invalid");
    panel.innerHTML = `<b>这版文案需要调整</b><br>${result.issues.map(item => `“${escapeHtml(item.sentence)}”${item.code === "spoiler" ? "提前揭示了故事保留的答案或结局。请把文案停在悬念揭晓前。" : `与正文中的人物、事件或因果不一致。${escapeHtml(item.message||"")} 请修改后重试。`}`).join("<br>")}`;
  } else {
    panel.innerHTML = `<span>${state.hookDirty ? "修改后需要重新进行内容检查。" : "等待检查"}</span>`;
  }
}

async function confirmHook() {
  const text = $("#hookEditor").value.trim();
  state.hookDraft = text;
  state.hookDirty = true;
  saveState();
  const count = countChars(text);
  if (count < 20 || count > 300) return renderValidation({ issues: [{ sentence: "传播文案", message: `需要 20—300 个非空白字符，当前 ${count} 个` }] });
  const button = $("#confirmHookBtn");
  setBusy(button, true, "正在检查文案与原作是否一致…");
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/select-hook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate_id: state.selectedCandidateId, final_text: text }),
    });
    renderValidation(result.selected_hook_profile);
    if (result.selected_hook_profile.validation_status !== "passed") return;
    state.selectedHook = result.selected_hook_profile;
    state.recommendation = result.material_recommendation;
    state.posterDesign = null;
    state.hookDirty = false;
    saveState();
    renderAction();
    showPage("action");
  } catch (error) {
    renderValidation({ issues: error.details || [{ sentence: "传播文案", message: error.message }] });
  } finally { setBusy(button, false); }
}

function renderAction() {
  if (!state.selectedHook || !state.recommendation) return;
  $("#finalHookText").textContent = state.selectedHook.final_text;
  const features=state.recommendation.deciding_features||[],needsContinuity=features.some(value=>/连续|节点 [3-9]/.test(value));
  $("#comicScore").textContent = needsContinuity ? "更推荐：文案包含连续动作，需要多张画面呈现。" : "适合：多个画面可以补充故事节奏。";
  $("#cardScore").textContent = needsContinuity ? "也可选择：用一个核心悬念集中呈现。" : "更推荐：核心信息可以在一张图中讲清楚。";
  const recommended = (needsContinuity || state.recommendation.recommended_type === "comic") ? "连续漫画" : "单图故事卡";
  const reason=needsContinuity?"文案包含多个情节节点，需要连续画面说明前后变化。":"一条规则或反差已经足够吸引读者。";
  $("#materialRecommendation").innerHTML = `<b>更适合${recommended}</b><span>${reason}</span>`;
  $("#musicEnabledInput").checked=Boolean(state.musicEnabled);
}

async function chooseMaterial(type) {
  state.materialType = type;
  state.backgroundId = "";
  state.posterDesign = null;
  saveState();
  if (type === "comic") { renderStyles(); return showPage("style"); }
  try {
    const category = state.analysis.story_profile.primary_category;
    const result = await api(`/api/backgrounds?category=${encodeURIComponent(category)}&project_id=${encodeURIComponent(state.project.id)}`);
    if (result.backgrounds.length !== 25) throw new Error("题材与时空底图库不完整，已阻止生成");
    state.backgrounds = result.backgrounds;
    renderBackgrounds();
    showPage("background");
  } catch (error) { toast(error.message); }
}

function renderBackgrounds() {
  if (!state.backgrounds.length) return;
  const shortText = groupShortLines(state.selectedHook?.selected_lines || []).map(stripPosterPunctuation).join("\n");
  const visible = state.backgrounds.filter(item => state.backgroundFilter === "all" || state.backgroundFilter === "recommended" && item.recommended || item.dimension === state.backgroundFilter);
  $("#backgroundGrid").innerHTML = visible.map(item => `<button class="background-option${item.id === state.backgroundId ? " is-selected" : ""}" data-background="${escapeAttr(item.id)}" type="button"><div class="background-art" style="--bg:${escapeAttr(item.css_background)}"><img src="${escapeAttr(item.thumbnail_url)}" alt="${escapeAttr(item.name)}底图"><span class="background-badge">${item.recommended ? "更相关" : item.dimension === "genre" ? "题材" : "时空"}</span><pre>${escapeHtml(shortText)}</pre></div><footer><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description)}</small></footer></button>`).join("");
  $$('[data-background]').forEach(button => button.onclick = () => {
    state.backgroundId = button.dataset.background;
    if (state.posterDesign?.backgroundId !== state.backgroundId) state.posterDesign = null;
    saveState(); renderBackgrounds();
  });
  const saved = state.posterDesign && state.posterDesign.backgroundId === state.backgroundId && state.posterDesign.previewDataUrl;
  $("#posterDraftPreview").hidden = !saved;
  if (saved) { $("#posterDraftImage").src = state.posterDesign.previewDataUrl; $("#posterDraftStyle").textContent = state.posterDesign.styleName || "单图故事卡定稿"; }
  $("#startCardBtn").disabled = !state.backgroundId;
  $("#startCardBtn").textContent = saved ? "查看生成设置" : "下一步：编辑单图故事卡";
  $("#backgroundHint").textContent = saved ? "排版已保存，可以生成" : state.backgroundId ? "底图已选择，请继续编辑排版" : "请选择一张底图";
  $$('[data-bg-filter]').forEach(button => button.classList.toggle("is-active", button.dataset.bgFilter === state.backgroundFilter));
}

function renderStyles() {
  const grid = $("#styleGrid"); if (!grid) return;
  grid.innerHTML = COMIC_STYLES.map(item => `<button class="style-option${item.id === state.comicStyleId ? " is-selected" : ""}" data-comic-style="${item.id}" type="button"><div class="style-swatch" style="--a:${item.colors[0]};--b:${item.colors[1]}"><i></i><i></i><i></i></div><footer><span>${item.sample}</span><b>${item.name}</b><small>${item.desc}</small></footer></button>`).join("");
  $$('[data-comic-style]').forEach(button => button.onclick = () => { state.comicStyleId = button.dataset.comicStyle; saveState(); renderStyles(); });
  $("#startComicBtn").disabled = !state.comicStyleId;
  $("#styleHint").textContent = state.comicStyleId ? `已选择：${COMIC_STYLES.find(item => item.id === state.comicStyleId)?.name}` : "请选择一种画风";
}

function openPosterEditor() {
  if (!state.backgroundId) return toast("请先选择底图");
  state.page = "background";
  saveState();
  location.href = "./poster-editor.html?mode=draft";
}

function showPreflight(type=state.materialType){
  state.materialType=type;
  const isComic=type==="comic",lineCount=state.selectedHook?.selected_lines?.length||4,pageCount=Math.min(8,Math.max(2,Math.ceil(lineCount/4)));
  $("#preflightTitle").textContent=isComic?"连续漫画生成前确认":"单图故事卡生成前确认";
  const background=state.backgrounds.find(item=>item.id===state.backgroundId);
  const beats=(state.selectedHook?.selected_lines||[]).slice(0,pageCount).map((line,index)=>`<li>${escapeHtml(line.text)}</li>`).join("");
  $("#preflightContent").innerHTML=isComic?`<dl><div><dt>预计页数</dt><dd>${pageCount} 页</dd></div><div><dt>文案摘要</dt><dd><ol>${beats}</ol></dd></div><div><dt>等待说明</dt><dd>${health?.mode==="demo"||health?.mode==="test"?"演示素材通常会较快完成":"生成需要一些时间，具体取决于服务响应。"}</dd></div></dl>`:`<dl><div><dt>已选背景</dt><dd>${escapeHtml(background?.name||"已保存背景")}</dd></div><div><dt>画面文案</dt><dd>${escapeHtml((state.posterDesign?.lines||[]).join(" / "))}</dd></div><div><dt>等待说明</dt><dd>${health?.mode==="demo"||health?.mode==="test"?"演示素材通常会较快完成":"生成需要一些时间，具体取决于服务响应。"}</dd></div></dl>`;
  if(!/^https:\/\/(?:www\.)?zhihu\.com\//i.test(state.project.sourceUrl||""))$("#preflightContent").insertAdjacentHTML("beforeend",'<p class="preflight-warning">你还没有填写知乎原作链接。可以继续生成预览，但填写链接后才能导出发布素材。</p>');
  $("#preflightMusicInput").checked=Boolean(state.musicEnabled);
  $("#preflightConfirmBtn").textContent=isComic?"开始生成连续漫画":"开始生成单图故事卡";
  $("#preflightDialog").showModal();
}

async function startGeneration(type = state.materialType) {
  if (!state.selectedHook || state.hookDirty) return toast("请先确认传播文案");
  if (type === "card" && !state.backgroundId) return toast("请先选择底图");
  if (type === "comic" && !state.comicStyleId) return toast("请先选择漫画画风");
  const posterDesign = type === "card" && state.posterDesign ? { style:state.posterDesign.style, style_name:state.posterDesign.styleName, tone:state.posterDesign.tone, lines:state.posterDesign.lines, positions:state.posterDesign.positions } : undefined;
  const payload = { selected_type: type, background_id: type === "card" ? state.backgroundId : undefined, comic_style: type === "comic" ? state.comicStyleId : undefined, poster_design:posterDesign, poster_image_data_url:type === "card" ? state.posterDesign?.previewDataUrl : undefined, music_enabled:Boolean(state.musicEnabled) };
  if(simulatedFailure)payload.simulate_failure=simulatedFailure;
  simulatedFailure = "";
  try {
    if (state.task && ["succeeded","partially_failed","failed"].includes(state.task.status) && !state.history.some(item => item.id === state.task.id)) state.history.push(clone(state.task));
    state.materialType = type;
    const subtasks=[{id:"visual_context",label:"整理角色和场景",status:"queued",message:"等待开始"},{id:"material",label:"生成图片",status:"queued",message:"等待开始"}];if(state.musicEnabled)subtasks.push({id:"music_prompt",label:"准备配乐",status:"queued",message:"等待开始"},{id:"music",label:"生成配乐",status:"queued",message:"等待开始"});
    state.task = { id:"", project_id:state.project.id, status:"queued", progress:2, message:"等待服务开始处理", subtasks, bundle:{selected_type:type,image_assets:[]} };
    renderTask(); showPage("progress");
    const task = await api(`/api/projects/${encodeURIComponent(state.project.id)}/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    state.task = task;
    saveState();
    renderTask();
    resumeTask();
  } catch (error) { state.task = null; showPage(type === "comic" ? "style" : "background"); toast(error.message); }
}

function resumeTask() {
  clearTimeout(pollTimer);
  pollAttempt=0;
  pollTask();
}

async function pollTask() {
  if (!state.task?.id) return;
  try {
    state.task = await api(`/api/tasks/${encodeURIComponent(state.task.id)}`);
    saveState(); renderTask();
    if (["queued", "running"].includes(state.task.status)){pollAttempt+=1;pollTimer = setTimeout(pollTask,Math.min(5000,1000*Math.pow(1.35,pollAttempt)));}
    else if (["succeeded", "partially_failed"].includes(state.task.status)) { renderResult(); showPage("result"); }
  } catch (error) {
    $("#progressMessage").textContent = `状态读取失败：${error.message}`;
    pollAttempt+=1;pollTimer = setTimeout(pollTask,Math.min(10000,2000*Math.pow(1.4,pollAttempt)));
  }
}

function renderTask() {
  const task = state.task;
  if (!task) return;
  const badge = $("#taskStatusBadge");
  badge.textContent = STATUS_LABELS[task.status] || "状态更新中";
  badge.dataset.status = task.status;
  $("#progressPercent").textContent = STATUS_LABELS[task.status] || "生成中";
  $("#progressBar").style.width = `${task.progress}%`;
  $("#progressTitle").textContent = STATUS_LABELS[task.status] || task.status;
  $("#progressMessage").textContent = userTaskMessage(task);
  $("#subtaskList").innerHTML = task.subtasks.map(sub => `<div class="subtask is-${escapeAttr(sub.status)}"><b>${escapeHtml(sub.label)}</b><span>${escapeHtml(STATUS_LABELS[sub.status] || "状态更新中")}</span><p>${escapeHtml(userSubtaskMessage(sub))}</p></div>`).join("");
  const retryable = ["failed", "partially_failed"].includes(task.status) && task.subtasks.some(item => item.status === "failed" && item.retryable);
  $("#retryTaskBtn").hidden = !retryable;
  $("#viewResultBtn").hidden = !["succeeded", "partially_failed"].includes(task.status);
  $("#cancelTaskBtn").hidden=!["queued","running"].includes(task.status);
  window.dispatchEvent(new CustomEvent("story-state",{detail:{page:state.page,task}}));
}

function userTaskMessage(task){
  if(task.status==="partially_failed")return "图片已经完成，配乐没有生成成功。你可以直接使用图片，或单独重试配乐。";
  if(task.status==="failed")return "生成没有完成。请重试；已完成的内容会保留。";
  if(task.status==="canceled")return "生成已取消。";
  if(task.status==="succeeded")return "素材已准备好，请复核后导出。";
  return task.status==="queued"?"等待服务开始处理。":"正在处理。返回不会取消当前生成任务。";
}
function userSubtaskMessage(sub){if(sub.status==="succeeded")return `${sub.label}已完成`;if(sub.status==="failed")return `${sub.label}没有完成，可以重试`;if(sub.status==="canceled")return "已取消";if(sub.status==="running")return `正在${sub.label}`;return "等待开始";}

async function cancelTask(){
  if(!state.task?.id)return;
  const button=$("#cancelTaskBtn");setBusy(button,true,"正在取消…");
  try{state.task=await api(`/api/tasks/${encodeURIComponent(state.task.id)}/cancel`,{method:"POST"});clearTimeout(pollTimer);saveState();renderTask();toast("生成已取消");}catch(error){toast(error.message);}finally{setBusy(button,false);}
}

async function retryTask() {
  const button = $("#retryTaskBtn");
  setBusy(button, true, "正在重试…");
  try {
    state.task = await api(`/api/tasks/${encodeURIComponent(state.task.id)}/retry`, { method: "POST" });
    saveState(); renderTask(); resumeTask();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

function renderResult() {
  const task = state.task;
  if (!task) return;
  const packageLink = $("#packageDownloadLink"); packageLink.hidden = true; packageLink.removeAttribute("href");
  assetObjectUrls.forEach(url=>URL.revokeObjectURL(url)); assetObjectUrls=[];
  const badge = $("#resultStatusBadge");
  badge.textContent = STATUS_LABELS[task.status] || "状态已更新";
  badge.dataset.status = task.status;
  const pages = task.bundle?.image_assets || [];
  if(!pages.length&&task.id&&!resultRefreshPending){resultRefreshPending=true;api(`/api/tasks/${encodeURIComponent(task.id)}`).then(latest=>{state.task=latest;saveState();resultRefreshPending=false;renderResult();}).catch(()=>{resultRefreshPending=false;});}
  const resultType = task.bundle?.selected_type || state.materialType;
  const resultHook = task.bundle?.selected_hook_profile || state.selectedHook;
  const metadata = { ...(task.bundle?.project_metadata || {}), title:state.project.title || task.bundle?.project_metadata?.title, author:state.project.author || task.bundle?.project_metadata?.author, source_url:state.project.sourceUrl || task.bundle?.project_metadata?.source_url || "" };
  const posterEditorLink = $("#posterEditorLink");
  posterEditorLink.hidden = resultType !== "card" || !pages.length;
  if (!posterEditorLink.hidden) posterEditorLink.href = "./poster-editor.html?mode=draft";
  $("#visualResultTitle").textContent = resultType === "comic" ? `连续漫画，共 ${pages.length} 页` : "单图故事卡";
  $("#assetCount").textContent = resultType === "comic"?`${pages.length} 页`:`${pages.length} 张`;
  $("#visualResults").classList.toggle("is-card", resultType === "card");
  $("#visualResults").innerHTML = pages.map((asset, index) => {
    const source=asset.image_url||asset.background_asset_url, isComic=resultType==="comic"&&asset.panels?.length;
    const copy=isComic ? (source && asset.text_embedded ? "" : `<div class="comic-page-overlay" style="--panels:${asset.panels.length}">${asset.panels.map(panel=>`<div class="comic-panel-copy is-${escapeAttr(panel.type)}"><span>${escapeHtml(panel.text)}</span></div>`).join("")}</div>`) : asset.prepared_poster ? "" : `<pre>${escapeHtml(asset.text)}</pre>`;
    const downloadLabel=resultType === "comic" ? `第 ${index + 1} 页` : "单图故事卡";
    const previous=asset.versions?.length?`${asset.versions.at(-1)?.preview_available?`<a class="text-button" href="/api/tasks/${encodeURIComponent(task.id)}/images/${index}/previous" target="_blank">查看上一版</a>`:""}<button class="text-button" data-restore-asset="${index}" type="button">恢复上一版</button>`:"";
    return `<article class="visual-result"><div class="visual-canvas${isComic?" is-comic":""}${asset.prepared_poster?" is-prepared":""}" data-visual="${index}" style="--bg:${escapeAttr(asset.css_background)}">${source ? `<img src="${escapeAttr(source)}" alt="第 ${index + 1} 张视觉底图">` : ""}${copy}${asset.show_attribution && !asset.prepared_poster ? `<small>《${escapeHtml(metadata.title)}》 · ${escapeHtml(metadata.author)} · AI 辅助 · 知乎阅读原作</small>` : ""}</div><div class="review-actions">${source?`<a class="text-button" href="${escapeAttr(source)}" target="_blank">查看大图</a>`:""}${resultType==="comic"?`<button class="text-button" data-report-asset="${index}" type="button">这页有问题</button>`:`<a class="text-button" href="./poster-editor.html?mode=draft">更换背景或重新排版</a>`}${previous}</div><div class="asset-actions"><button class="asset-action asset-download" data-download-asset="${index}" type="button"><span><b>准备${downloadLabel}</b><small>生成高清 PNG 文件</small></span><i aria-hidden="true">↓</i></button><a class="asset-action asset-download-link" data-asset-link="${index}" href="#" download hidden><span><b>下载${downloadLabel}</b><small>PNG · 1080 × 1440</small></span><i aria-hidden="true">↓</i></a></div></article>`;
  }).join("");
  $$('[data-download-asset]').forEach(button => button.onclick = async () => { const index=Number(button.dataset.downloadAsset); setBusy(button,true,"正在生成 PNG…"); try { const url=URL.createObjectURL(await canvasBlob(pages[index])); assetObjectUrls.push(url); const link=$(`[data-asset-link="${index}"]`);link.href=url;link.download=resultType === "comic" ? `${safeName(metadata.title)}-漫画-${String(index+1).padStart(2,"0")}.png` : `${safeName(metadata.title)}-单图故事卡.png`;link.hidden=false;button.hidden=true;toast("PNG 已准备，请点击下载链接保存"); } catch(error) { toast(`PNG 准备失败：${error.message}`); } finally { setBusy(button,false); } });
  $$('[data-report-asset]').forEach(button=>button.onclick=()=>openIssueDialog(Number(button.dataset.reportAsset)));
  $$('[data-restore-asset]').forEach(button=>button.onclick=()=>restoreAsset(Number(button.dataset.restoreAsset)));
  $("#publishCopy").textContent = resultHook.final_text;
  $("#musicPreset").textContent = task.music_enabled ? (task.bundle?.music_profile?.preset_label || "正在准备配乐") : "本次未选择配乐";
  const music = task.subtasks.find(item => item.id === "music");
  $("#audioState").textContent = !task.music_enabled?"配乐为可选项，本次未生成。":music?.status==="succeeded"?`配乐已生成，时长约 ${task.bundle?.music_profile?.duration||20} 秒。`:"配乐没有生成成功，不影响图片和传播文案的使用。";
  prepareAudio(music?.status === "succeeded", task.bundle?.audio_url);
  resetVideo(music?.status === "succeeded" && pages.length > 0);
  const hasUrl = /^https:\/\/(?:www\.)?zhihu\.com\//i.test(metadata.source_url || "");
  $("#exportWarning").className = `export-warning${hasUrl ? "" : " is-error"}`;
  $("#exportWarning").textContent = hasUrl ? "发布包将包含作品名、作者署名、知乎原作链接和 AI 辅助生成说明。" : "请填写有效的知乎原作链接后再导出发布素材。";
  $("#exportPackageBtn").disabled = !hasUrl || !pages.length;
  renderHistory();
}

let issueAssetIndex=-1;
function openIssueDialog(index){issueAssetIndex=index;$("#issueDialogTitle").textContent=`第 ${index+1} 页有什么问题？`;$("#issueConfirmText").textContent=`只会重新生成第 ${index+1} 页，其他页面不会改变。`;$("#issueNoteInput").value="";$("#regenerateAssetBtn").textContent=`重新生成第 ${index+1} 页`;$("#issueDialog").showModal();}
async function regenerateAsset(){if(issueAssetIndex<0)return;const button=$("#regenerateAssetBtn");setBusy(button,true,"正在提交…");try{state.task=await api(`/api/tasks/${encodeURIComponent(state.task.id)}/assets/${issueAssetIndex}/regenerate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({issue_type:$("#issueTypeInput").value,note:$("#issueNoteInput").value})});$("#issueDialog").close();saveState();renderTask();showPage("progress");resumeTask();}catch(error){toast(error.message);}finally{setBusy(button,false);}}
async function restoreAsset(index){try{state.task=await api(`/api/tasks/${encodeURIComponent(state.task.id)}/assets/${index}/restore`,{method:"POST"});saveState();renderResult();toast(`已恢复第 ${index+1} 页的上一版`);}catch(error){toast(error.message);}}

function renderHistory() {
  const rows = (state.history || []).filter(item => item.id !== state.task?.id);
  $("#historyWrap").hidden = !rows.length;
  $("#historyList").innerHTML = rows.map(item => `<button class="text-button" type="button" data-history-task="${escapeAttr(item.id)}">${item.bundle?.selected_type === "comic" ? "连续漫画" : "单图故事卡"} · ${escapeHtml(STATUS_LABELS[item.status] || "状态已更新")}</button>`).join("");
  $$('[data-history-task]').forEach(button => button.onclick = () => { const previous=state.history.find(item=>item.id===button.dataset.historyTask); if(!previous)return; if(state.task&&!state.history.some(item=>item.id===state.task.id))state.history.push(clone(state.task)); state.task=clone(previous); state.materialType=state.task.bundle?.selected_type||state.materialType; saveState(); renderResult(); showPage("result"); });
}

function prepareAudio(available, serverUrl) {
  const button = $("#bgmPlayBtn");
  if (audioSource) { try { audioSource.stop(); } catch {} audioSource = null; }
  audioServerUrl = available && serverUrl ? serverUrl : "";
  button.hidden = !audioServerUrl;
  button.disabled = false;
  button.textContent = "试听配乐";
}

function resetVideo(enabled) {
  if (videoObjectUrl) { URL.revokeObjectURL(videoObjectUrl); videoObjectUrl=""; }
  const video=$("#videoPreview"), link=$("#videoDownloadLink"), button=$("#buildVideoBtn");
  video.pause(); video.hidden=true; video.removeAttribute("src"); link.hidden=true; link.removeAttribute("href");
  button.disabled=!enabled;
  $("#videoState").textContent=enabled ? "点击生成后，浏览器会按配乐时长实时合成带声音的视频。" : "图片或配乐尚未成功，暂时无法合成视频。";
}

async function buildVideoPreview() {
  if (!audioServerUrl || !state.task?.bundle?.image_assets?.length) return toast("图片与配乐均成功后才能生成视频");
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return toast("当前浏览器不支持视频合成，请使用最新版 Chrome 或 Edge");
  const button=$("#buildVideoBtn"); setBusy(button,true,"正在实时合成…");
  try {
    const assets=state.task.bundle.image_assets;
    const bitmaps=[];
    for(const asset of assets) bitmaps.push(await createImageBitmap(await canvasBlob(asset)));
    const audioData=await fetch(audioServerUrl).then(response=>{if(!response.ok)throw new Error("配乐读取失败");return response.arrayBuffer();});
    const context=new (window.AudioContext||window.webkitAudioContext)();
    const decoded=await context.decodeAudioData(audioData.slice(0));
    const canvas=Object.assign(document.createElement("canvas"),{width:720,height:960}),ctx=canvas.getContext("2d");
    const canvasStream=canvas.captureStream(12),destination=context.createMediaStreamDestination();
    const source=context.createBufferSource(); source.buffer=decoded; source.connect(destination);
    const stream=new MediaStream([...canvasStream.getVideoTracks(),...destination.stream.getAudioTracks()]);
    const mime=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(type=>MediaRecorder.isTypeSupported(type))||"";
    const recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:3000000}:undefined),chunks=[];
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    const startedAt=context.currentTime;
    const draw=()=>{const elapsed=Math.max(0,context.currentTime-startedAt),index=Math.min(bitmaps.length-1,Math.floor(elapsed/Math.max(.1,decoded.duration/bitmaps.length)));ctx.drawImage(bitmaps[index],0,0,720,960);};
    draw(); const timer=setInterval(draw,1000/12);
    const finished=new Promise((resolve,reject)=>{recorder.onerror=()=>reject(recorder.error||new Error("视频编码失败"));recorder.onstop=resolve;});
    recorder.start(1000); source.start();
    source.onended=()=>{clearInterval(timer);draw();recorder.stop();canvasStream.getTracks().forEach(track=>track.stop());};
    await finished; await context.close(); bitmaps.forEach(bitmap=>bitmap.close());
    const blob=new Blob(chunks,{type:mime||"video/webm"}); if(!blob.size)throw new Error("视频文件为空");
    if(videoObjectUrl)URL.revokeObjectURL(videoObjectUrl); videoObjectUrl=URL.createObjectURL(blob);
    const video=$("#videoPreview"),link=$("#videoDownloadLink"); video.src=videoObjectUrl;video.hidden=false;link.href=videoObjectUrl;link.download=`${safeName(state.project.title)}-${state.task.bundle.selected_type === "comic" ? "漫画" : "单图故事卡"}.webm`;link.hidden=false;
    $("#videoState").textContent=`已合成 ${decoded.duration.toFixed(1)} 秒 WebM 视频（图片 + 配乐）。`;
  } catch(error) { toast(`视频生成失败：${error.message}`); }
  finally { setBusy(button,false); }
}

function parsePcmWav(arrayBuffer) {
  const view = new DataView(arrayBuffer), ascii = (offset, length) => String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("音频不是有效 WAV");
  let offset = 12, format = null, dataOffset = -1, dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset, 4), size = view.getUint32(offset + 4, true), body = offset + 8;
    if (id === "fmt " && size >= 16) format = { codec:view.getUint16(body,true), channels:view.getUint16(body+2,true), sampleRate:view.getUint32(body+4,true), blockAlign:view.getUint16(body+12,true), bits:view.getUint16(body+14,true) };
    if (id === "data") { dataOffset = body; dataSize = Math.min(size, view.byteLength - body); break; }
    offset = body + size + (size % 2);
  }
  if (!format || format.codec !== 1 || format.bits !== 16 || dataOffset < 0 || !format.channels || !format.blockAlign) throw new Error("仅支持 16-bit PCM WAV 试听");
  const frames = Math.floor(dataSize / format.blockAlign), channels = Array.from({length:format.channels},()=>new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < format.channels; channel++) channels[channel][frame] = view.getInt16(dataOffset + frame * format.blockAlign + channel * 2, true) / 32768;
  return { ...format, frames, channels };
}

async function toggleAudioPreview() {
  const button = $("#bgmPlayBtn");
  if (audioSource) { audioSource.stop(); audioSource = null; button.textContent = "试听配乐"; return; }
  if (!audioServerUrl) return;
  button.disabled = true; button.textContent = "正在载入…";
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();
    const response = await fetch(audioServerUrl); if (!response.ok) throw new Error(`音频读取失败（${response.status}）`);
    const wav = parsePcmWav(await response.arrayBuffer()), buffer = audioContext.createBuffer(wav.channels.length, wav.frames, wav.sampleRate);
    wav.channels.forEach((channel,index)=>buffer.copyToChannel(channel,index));
    const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination); audioSource = source;
    source.onended = () => { if (audioSource === source) audioSource = null; button.disabled = false; button.textContent = "试听配乐"; };
    source.start(); button.disabled = false; button.textContent = "停止试听";
  } catch (error) { audioSource = null; button.disabled = false; button.textContent = "试听配乐"; toast(`试听失败：${error.message}`); }
}

function canvasTextLines(ctx, text, maxWidth) {
  const result=[]; let line="";
  for(const char of [...String(text||"")]){const next=line+char;if(line&&ctx.measureText(next).width>maxWidth){result.push(line);line=char;}else line=next;}
  if(line)result.push(line); return result;
}
function roundedPath(ctx,x,y,w,h,r){const radius=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+radius,y);ctx.arcTo(x+w,y,x+w,y+h,radius);ctx.arcTo(x+w,y+h,x,y+h,radius);ctx.arcTo(x,y+h,x,y,radius);ctx.arcTo(x,y,x+w,y,radius);ctx.closePath();}
function drawComicCopies(ctx, asset) {
  const panels=asset.panels||[], count=panels.length; if(!count)return;
  const panelHeight=1440/count;
  ctx.save();
  for(let i=1;i<count;i++){ctx.fillStyle="#fff";ctx.fillRect(0,Math.round(i*panelHeight)-6,1080,12);}
  panels.forEach((panel,index)=>{
    const dialogue=panel.type==="dialogue", x=dialogue?360:42, width=dialogue?670:930, top=index*panelHeight+26;
    ctx.font='600 34px "Microsoft YaHei"'; const lines=canvasTextLines(ctx,panel.text,width-64).slice(0,3), lineHeight=48, height=Math.min(panelHeight-52,lines.length*lineHeight+38);
    roundedPath(ctx,x,top,width,height,dialogue?30:16);ctx.fillStyle="rgba(255,255,255,.95)";ctx.fill();ctx.lineWidth=3;ctx.strokeStyle="rgba(20,24,29,.9)";ctx.stroke();
    if(dialogue){ctx.beginPath();ctx.moveTo(x+70,top+height-2);ctx.lineTo(x+34,top+height+28);ctx.lineTo(x+112,top+height-2);ctx.closePath();ctx.fillStyle="rgba(255,255,255,.95)";ctx.fill();}
    ctx.fillStyle="#171b22";ctx.textAlign="left";ctx.textBaseline="top";lines.forEach((line,lineIndex)=>ctx.fillText(line,x+32,top+19+lineIndex*lineHeight));
  });
  ctx.restore();
}
async function canvasBlob(asset) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 1080, height: 1440 });
  const ctx = canvas.getContext("2d");
  let drewModelImage = false;
  const sourceImage=asset.image_url||asset.background_asset_url;
  if (sourceImage) {
    try {
      const blob = await fetch(sourceImage).then(response => { if (!response.ok) throw new Error("图片读取失败"); return response.blob(); });
      const bitmap = await createImageBitmap(blob), scale = Math.max(1080 / bitmap.width, 1440 / bitmap.height), width = bitmap.width * scale, height = bitmap.height * scale;
      ctx.drawImage(bitmap, (1080 - width) / 2, (1440 - height) / 2, width, height); bitmap.close(); drewModelImage = true;
    } catch { drewModelImage = false; }
  }
  if (!drewModelImage) { const colors = asset.colors || ["#162331", "#6a3b48"], gradient = ctx.createLinearGradient(0, 0, 1080, 1440); gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1080, 1440); }
  if(asset.layout==="vertical_storyboard"&&asset.panels?.length&&!(drewModelImage&&asset.text_embedded)) drawComicCopies(ctx,asset);
  else if(!asset.prepared_poster){ctx.fillStyle="rgba(0,0,0,.25)";ctx.fillRect(0,0,1080,1440);ctx.fillStyle="#fff";ctx.textAlign="center";ctx.font='600 48px "Microsoft YaHei"';const lines=String(asset.text).split("\n").filter(Boolean),start=610-lines.length*42;lines.forEach((line,i)=>ctx.fillText(line,540,start+i*92,820));}
  if(asset.show_attribution&&!asset.prepared_poster){const metadata=state.task?.bundle?.project_metadata||{title:state.project.title,author:state.project.author};ctx.fillStyle="rgba(0,0,0,.68)";ctx.fillRect(0,1388,1080,52);ctx.textAlign="center";ctx.textBaseline="middle";ctx.font='24px "Microsoft YaHei"';ctx.fillStyle="#fff";ctx.fillText(`《${metadata.title}》 · ${metadata.author} · AI 辅助 · 知乎阅读原作`,540,1414,980);}
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

async function exportPackage() {
  const button = $("#exportPackageBtn");
  setBusy(button, true, "正在准备下载文件…");
  try {
    if (state.task.project_id !== state.project.id) throw new Error("当前任务不属于正在编辑的项目，请返回作品页重新生成");
    await api(`/api/projects/${encodeURIComponent(state.project.id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:state.project.title,author:state.project.author,source_url:state.project.sourceUrl})});
    const exportInfo=await api(`/api/projects/${encodeURIComponent(state.project.id)}/export?task_id=${encodeURIComponent(state.task.id)}`);
    const assets = state.task.bundle.image_assets, resultHook = state.task.bundle?.selected_hook_profile || state.selectedHook, resultType=state.task.bundle?.selected_type || state.materialType;
    const metadata = state.task.bundle?.project_metadata || { title:state.project.title, author:state.project.author, source_url:state.project.sourceUrl };
    for(let i=0;i<assets.length;i++){const blob=await canvasBlob(assets[i]),saved=await fetch(`/api/tasks/${encodeURIComponent(state.task.id)}/final-images/${i}`,{method:"POST",headers:{"Content-Type":"image/png"},body:blob});if(!saved.ok)throw new Error((await saved.json().catch(()=>({}))).error||`第 ${i+1} 张图片准备失败`);}
    const link = $("#packageDownloadLink");
    link.href = exportInfo.download_url;
    link.download = `${safeName(metadata.title)}-宣传素材.zip`;
    link.hidden = false;
    toast("发布包已准备好，请点击下载。");
    window.dispatchEvent(new CustomEvent("story-complete",{detail:{key:state.task.id,type:"export"}}));
  } catch (error) { toast(`导出失败：${error.message}`); }
  finally { setBusy(button, false); }
}

function safeName(value) { return String(value || "story").replace(/[\\/:*?"<>|]/g, "-"); }
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const a = Object.assign(document.createElement("a"), { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

async function importFile(file) {
  try {
    const text = file.name.toLowerCase().endsWith(".docx") ? await readDocx(file) : await file.text();
    if (!text.trim()) throw new Error("文件中没有可读取的正文");
    $("#bodyInput").value = text.trim();
    if (!$("#titleInput").value) $("#titleInput").value = file.name.replace(/\.(txt|md|markdown|docx)$/i, "");
    updateBodyCount(); syncProjectFromInputs(); toast("正文已导入");
  } catch (error) { $("#inputError").textContent = file.name.toLowerCase().endsWith(".docx") ? "没有成功读取这个 DOCX。你可以另存为 TXT，或直接粘贴正文。" : error.message.includes("没有可读取") ? "文件中没有可读取的正文，请检查文件后重试。" : `文件没有读取成功：${error.message}`; }
}

async function readDocx(file) {
  const data = new Uint8Array(await file.arrayBuffer()), view = new DataView(data.buffer);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("DOCX ZIP 目录缺失");
  const count = view.getUint16(eocd + 10, true), centralOffset = view.getUint32(eocd + 16, true); let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true), nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true), localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.slice(p + 46, p + 46 + nameLen));
    if (name === "word/document.xml") {
      const localNameLen = view.getUint16(localOffset + 26, true), localExtra = view.getUint16(localOffset + 28, true), start = localOffset + 30 + localNameLen + localExtra, compressed = data.slice(start, start + size);
      let bytes = compressed;
      if (method === 8) bytes = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      if (![0, 8].includes(method)) throw new Error("DOCX 使用了不支持的压缩格式");
      const xml = new TextDecoder().decode(bytes).replace(/<w:tab\s*\/>/g, "\t").replace(/<w:br\s*\/>/g, "\n").replace(/<\/w:p>/g, "\n");
      return new DOMParser().parseFromString(xml, "application/xml").documentElement.textContent.replace(/\n{3,}/g, "\n\n");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("DOCX 中没有 word/document.xml");
}

async function loadSample(id) {
  state.project.sampleId=id||"";if (!id){saveState();return;}
  try {
    const sample = await api(`/api/samples/${encodeURIComponent(id)}`);
    $("#titleInput").value = sample.title;
    $("#authorInput").value = sample.author_name || "授权样例作者";
    $("#sourceUrlInput").value = sample.source_url || "";
    $("#bodyInput").value = sample.body;
    $("#authorizationInput").checked = false;
    state.project.labels = sample.labels || [];
    updateBodyCount(); syncProjectFromInputs(); toast("已载入授权样例，可用于体验创作流程");
  } catch (error) { toast(error.message); }
}

async function downloadHook() {
  try { const response = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/hooks/selected/export`); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `下载失败（${response.status}）`); downloadBlob(await response.blob(), "传播文案.txt"); }
  catch (error) { toast(error.message); }
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast("已复制"); } catch { toast("浏览器未开放剪贴板权限"); } }

async function deleteCurrentProject(){const button=$("#confirmDeleteBtn");setBusy(button,true,"正在删除…");try{if(state.project.id)await api(`/api/projects/${encodeURIComponent(state.project.id)}`,{method:"DELETE"});clearTimeout(pollTimer);for(const key of [STORAGE_KEY,...LEGACY_STORAGE_KEYS]){sessionStorage.removeItem(key);localStorage.removeItem(key);}for(const key of Object.keys(localStorage))if(key.startsWith("poster-style-draft-"))localStorage.removeItem(key);state=blankState();$("#deleteDialog").close();hydrateInputs();renderAll();toast("作品及生成记录已删除。");}catch(error){toast(error.message);}finally{setBusy(button,false);}}

function bindEvents() {
  ["titleInput", "authorInput", "sourceUrlInput", "authorizationInput"].forEach(id => $(`#${id}`).addEventListener("input", syncProjectFromInputs));
  $("#bodyInput").addEventListener("input", () => { updateBodyCount(); syncProjectFromInputs(); });
  $("#analyzeBtn").onclick = analyze;
  $("#hookEditor").addEventListener("input", event => { state.hookDraft = event.target.value; state.hookDirty = true; state.selectedHook = null; updateHookLength(); renderValidation(); saveState(); });
  $("#confirmHookBtn").onclick = confirmHook;
  $$('[data-material]').forEach(button => button.onclick = () => chooseMaterial(button.dataset.material));
  $("#startComicBtn").onclick = () => showPreflight("comic");
  $("#startCardBtn").onclick = () => state.posterDesign?.backgroundId === state.backgroundId && state.posterDesign?.previewDataUrl ? showPreflight("card") : openPosterEditor();
  $("#editPosterBtn").onclick = openPosterEditor;
  $$('[data-bg-filter]').forEach(button => button.onclick = () => { state.backgroundFilter=button.dataset.bgFilter; saveState(); renderBackgrounds(); });
  $("#retryTaskBtn").onclick = retryTask;
  $("#cancelTaskBtn").onclick=cancelTask;
  $("#viewResultBtn").onclick = () => { renderResult(); showPage("result"); };
  $("#copyHookBtn").onclick = () => copyText(state.selectedHook.final_text);
  $("#copyResultHookBtn").onclick = () => copyText((state.task?.bundle?.selected_hook_profile || state.selectedHook).final_text);
  $("#downloadHookBtn").onclick = downloadHook;
  $("#exportPackageBtn").onclick = exportPackage;
  $("#packageDownloadLink").onclick = () => toast("已发起下载，请在浏览器下载列表中确认。");
  $("#bgmPlayBtn").onclick = toggleAudioPreview;
  $("#buildVideoBtn").onclick = buildVideoPreview;
  $("#otherMaterialBtn").onclick = () => showPage("action");
  $("#uploadBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = event => { const file = event.target.files[0]; if (file) importFile(file); event.target.value = ""; };
  $("#pasteBtn").onclick = async () => { try { $("#bodyInput").value = await navigator.clipboard.readText(); updateBodyCount(); syncProjectFromInputs(); } catch { toast("浏览器未开放剪贴板读取权限，请直接粘贴"); } };
  $("#sampleSelect").onchange = event => loadSample(event.target.value);
  $("#sourceUrlInput").onblur=()=>validateSourceUrl(true);
  $("#musicEnabledInput").onchange=event=>{state.musicEnabled=event.target.checked;saveState();};
  $("#preflightMusicInput").onchange=event=>{state.musicEnabled=event.target.checked;$("#musicEnabledInput").checked=state.musicEnabled;saveState();};
  $("#preflightBackBtn").onclick=()=>$("#preflightDialog").close();
  $("#preflightConfirmBtn").onclick=()=>{const type=state.materialType;$("#preflightDialog").close();startGeneration(type);};
  $("#serviceDetailsBtn").onclick=()=>$("#serviceDialog").showModal();
  $("#deleteProjectBtn").onclick=()=>$("#deleteDialog").showModal();
  $("#confirmDeleteBtn").onclick=deleteCurrentProject;
  $("#regenerateAssetBtn").onclick=regenerateAsset;
  $$('[data-close-dialog]').forEach(button=>button.onclick=()=>$("#"+button.dataset.closeDialog).close());
  $$('[data-action="go-input"]').forEach(button => button.onclick = event => { event.preventDefault(); showPage("input"); });
  $$('[data-action="back-hooks"]').forEach(button => button.onclick = () => $("#backHookDialog").showModal());
  $("#confirmBackHookBtn").onclick=()=>{$("#backHookDialog").close();state.hookDraft=state.selectedHook.final_text;state.hookDirty=true;showPage("hooks");renderHooks();};
  $$('[data-action="go-action"]').forEach(button => button.onclick = () => showPage("action"));
  $$('[data-step]').forEach(button => button.onclick = () => { if (canVisit(button.dataset.step)) { if (button.dataset.step === "result") renderResult(); showPage(button.dataset.step); } });
}

window.NovelPromoWorkbench = {
  getState: () => clone(state),
  simulateNextFailure(kind = "music") { if(health?.mode!=="test")throw new Error("仅测试环境可用");simulatedFailure = kind; return `下一次生成将模拟 ${kind} 失败`; },
  reset() { state = blankState(); saveState(); hydrateInputs(); renderAll(); },
};

init();
