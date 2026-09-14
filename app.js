const STORAGE_KEY = "zhihu-story-workbench-v11";
const MAX_BODY = 50000;
const TYPE_LABELS = {
  relationship_tension: "关系张力型",
  abnormal_setting: "异常设定型",
  identity_contrast: "身份反差型",
  crisis_choice: "危机选择型",
  emotional_scene: "情绪名场面型",
};
const STATUS_LABELS = {
  queued: "已排队", running: "生成中", succeeded: "已完成",
  partially_failed: "部分失败", failed: "失败",
};
const STEP_ORDER = ["input", "analysis", "hooks", "action", "style", "background", "progress", "result"];
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
  project: { id: "", title: "", author: "", sourceUrl: "", authorized: false, body: "", labels: [] },
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
  task: null,
  history: [],
});
let state = loadState();
let health = null;
let pollTimer = null;
let audioServerUrl = "";
let audioContext = null;
let audioSource = null;
let simulatedFailure = "";
let analysisTimer = null;
let analysisStartedAt = 0;
let videoObjectUrl = "";
let assetObjectUrls = [];

function loadState() {
  for (const raw of [sessionStorage.getItem(STORAGE_KEY), localStorage.getItem(STORAGE_KEY)]) try {
    const value = JSON.parse(raw);
    if (value?.project) {
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
  const snapshot = JSON.stringify(state);
  sessionStorage.setItem(STORAGE_KEY, snapshot);
  localStorage.setItem(STORAGE_KEY, snapshot);
}

function countChars(text = "") { return String(text).replace(/[\s]/g, "").length; }
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
  setTimeout(() => item.remove(), 3000);
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
  await Promise.allSettled([checkHealth(), loadSamples()]);
  renderAll();
  if (state.task && ["queued", "running"].includes(state.task.status)) resumeTask();
}

async function checkHealth() {
  try {
    health = await api("/api/health");
    const el = $("#serviceState");
    el.className = `service-state ${health.text_model?.verified ? "is-live" : "is-demo"}`;
    const music = health.music?.reachable ? "本机 BGM 服务可连接" : "BGM 未连接";
    const textState = health.text_model?.verified
      ? `钩子模型已验证（${health.text_model.model}）`
      : health.text_model?.configured
        ? `钩子模型已配置，等待首次真实调用验证（${health.text_model.model}）`
        : "钩子模型未配置（不会返回模拟结果）";
    el.querySelector("span").textContent = `${textState} · ${music}`;
  } catch {
    $("#serviceState").querySelector("span").textContent = "服务状态未知";
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
  updateBodyCount();
}

function syncProjectFromInputs() {
  state.project.title = $("#titleInput").value.trim();
  state.project.author = $("#authorInput").value.trim();
  state.project.sourceUrl = $("#sourceUrlInput").value.trim();
  state.project.authorized = $("#authorizationInput").checked;
  state.project.body = $("#bodyInput").value;
  saveState();
}

function updateBodyCount() {
  const count = countChars($("#bodyInput").value);
  const el = $("#charCount");
  el.textContent = `${count.toLocaleString("zh-CN")} / ${MAX_BODY.toLocaleString("zh-CN")}`;
  el.classList.toggle("is-error", count > MAX_BODY);
  $("#inputError").textContent = count > MAX_BODY ? `正文超出 ${count - MAX_BODY} 个字符，请删减后再分析。系统不会截断正文。` : "";
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
  if (!STEP_ORDER.includes(page)) page = "input";
  state.page = page;
  $$('[data-page]').forEach(section => { section.hidden = section.dataset.page !== page; });
  const current = STEP_ORDER.indexOf(page);
  $$('[data-step]').forEach(button => {
    const index = STEP_ORDER.indexOf(button.dataset.step);
    button.classList.toggle("is-current", index === current);
    button.classList.toggle("is-complete", index < current);
    button.disabled = !canVisit(button.dataset.step);
  });
  if (persist) saveState();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  if (!state.project.title) errors.push("请填写作品名");
  if (!state.project.author) errors.push("请填写作者名");
  const count = countChars(state.project.body);
  if (!count) errors.push("请粘贴或上传完整正文");
  if (count > MAX_BODY) errors.push(`正文超出 ${count - MAX_BODY} 个字符`);
  if (!state.project.authorized) errors.push("请确认作品授权");
  $("#inputError").textContent = errors.join("；");
  return errors.length === 0;
}

async function analyze() {
  if (!validateInput()) return;
  const button = $("#analyzeBtn");
  setBusy(button, true, "正在分析全文…");
  analysisStartedAt = Date.now();
  showPage("analysis");
  updateAnalysisProgress();
  try {
    const result = await api("/api/projects/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: state.project.title, author: state.project.author, source_url: state.project.sourceUrl, authorized: state.project.authorized, body: state.project.body, labels: state.project.labels }),
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
    $("#analysisPercent").textContent = "100%";
    $("#analysisPhase").textContent = "分析完成，正在打开候选钩子…";
    saveState();
    renderHooks();
    await new Promise(resolve => setTimeout(resolve, 450));
    showPage("hooks");
    toast(`已生成 ${result.candidates.length} 条合格候选`);
  } catch (error) {
    $("#inputError").textContent = error.message;
    showPage("input");
  } finally { clearInterval(analysisTimer); setBusy(button, false); }
}

function updateAnalysisProgress() {
  clearInterval(analysisTimer);
  const tick = () => {
    const seconds = (Date.now() - analysisStartedAt) / 1000;
    const percent = Math.min(94, Math.round(8 + 86 * (1 - Math.exp(-seconds / 58))));
    const phases = percent < 30 ? "正在阅读全文并建立人物、事件与证据索引…" : percent < 60 ? "正在识别主类别、题材与时空…" : "正在一次性生成三种不同角度的钩子…";
    $("#analysisBar").style.width = `${percent}%`;
    $("#analysisPercent").textContent = `${percent}%`;
    $("#analysisPhase").textContent = phases;
  };
  tick(); analysisTimer = setInterval(tick, 800);
}

function renderHooks() {
  if (!state.analysis) return;
  const profile = state.analysis.story_profile;
  $("#analysisSummary").innerHTML = `<span>规则识别主类别 <b>${escapeHtml(profile.primary_category_label)}</b></span><span>AI 分析语气 <b>${escapeHtml(state.analysis.content_analysis.tone_profile_label)}</b></span><span>叙事人称 <b>${state.analysis.content_analysis.narrative_person === "first_person" ? "第一人称" : "第三人称"}</b></span><span>候选 <b>${state.analysis.candidates.length} 条</b></span><span>生成方式 <b>单次 API · 未追加模型质检</b></span>`;
  $("#hookGrid").innerHTML = state.analysis.candidates.map(candidate => {
    const selected = candidate.candidate_id === state.selectedCandidateId;
    return `<button class="hook-card${selected ? " is-selected" : ""}" data-candidate="${escapeAttr(candidate.candidate_id)}" type="button"><header><span class="hook-type">${escapeHtml(TYPE_LABELS[candidate.hook_type] || candidate.hook_type)}</span><small>${selected ? "已选" : `推荐分 ${candidate.rank_score.toFixed(1)}`}</small></header><pre>${escapeHtml(candidate.rendered_text)}</pre><p>${escapeHtml(candidate.recommendation_reason)}</p><footer><span>AI 候选建议：${candidate.recommended_material === "comic" ? "漫画" : "宣传图"}</span><span>使用此候选</span></footer></button>`;
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
    panel.innerHTML = `<b>校验通过</b> · 事实有据、未越过剧透边界；已重新识别钩子类型、情绪和形式建议。`;
  } else if (result?.issues?.length) {
    panel.classList.add("is-invalid");
    panel.innerHTML = `<b>校验未通过</b><br>${result.issues.map(item => `“${escapeHtml(item.sentence)}” — ${escapeHtml(item.message)}`).join("<br>")}`;
  } else {
    panel.innerHTML = `<span>${state.hookDirty ? "修改后需要重新校验；未通过前不能进入视觉生成。" : "等待校验"}</span>`;
  }
}

async function confirmHook() {
  const text = $("#hookEditor").value.trim();
  state.hookDraft = text;
  state.hookDirty = true;
  saveState();
  const count = countChars(text);
  if (count < 20 || count > 300) return renderValidation({ issues: [{ sentence: "钩子全文", message: `需为 20—300 个非空白字符，当前 ${count} 个` }] });
  const button = $("#confirmHookBtn");
  setBusy(button, true, "正在校验…");
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/select-hook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate_id: state.selectedCandidateId, final_text: text }),
    });
    renderValidation(result.selected_hook_profile);
    if (result.selected_hook_profile.validation_status !== "passed") return;
    state.selectedHook = result.selected_hook_profile;
    state.recommendation = result.material_recommendation;
    state.hookDirty = false;
    saveState();
    renderAction();
    showPage("action");
  } catch (error) {
    renderValidation({ issues: error.details || [{ sentence: "钩子全文", message: error.message }] });
  } finally { setBusy(button, false); }
}

function renderAction() {
  if (!state.selectedHook || !state.recommendation) return;
  $("#finalHookText").textContent = state.selectedHook.final_text;
  $("#comicScore").textContent = `适配评分 ${state.recommendation.comic_score}`;
  $("#cardScore").textContent = `适配评分 ${state.recommendation.card_score}`;
  const recommended = state.recommendation.recommended_type === "comic" ? "连续漫画" : "单图宣传卡";
  $("#materialRecommendation").innerHTML = `<b>形式建议：${recommended}</b> · 该建议由程序根据 AI 识别出的钩子类型、对白轮次和叙事节点计算，并非额外一次 AI 判断。${escapeHtml(state.recommendation.deciding_features.join("；"))}。两个入口均可分别制作。`;
}

async function chooseMaterial(type) {
  state.materialType = type;
  state.backgroundId = "";
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
  const shortText = groupShortLines(state.selectedHook?.selected_lines || []).join("\n");
  const visible = state.backgrounds.filter(item => state.backgroundFilter === "all" || state.backgroundFilter === "recommended" && item.recommended || item.dimension === state.backgroundFilter);
  $("#backgroundGrid").innerHTML = visible.map(item => `<button class="background-option${item.id === state.backgroundId ? " is-selected" : ""}" data-background="${escapeAttr(item.id)}" type="button"><div class="background-art" style="--bg:${escapeAttr(item.css_background)}"><img src="${escapeAttr(item.thumbnail_url)}" alt="${escapeAttr(item.name)}底图"><span class="background-badge">${item.recommended ? "AI 相关" : item.dimension === "genre" ? "题材" : "时空"}</span><pre>${escapeHtml(shortText)}</pre></div><footer><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description)}</small></footer></button>`).join("");
  $$('[data-background]').forEach(button => button.onclick = () => {
    state.backgroundId = button.dataset.background;
    saveState(); renderBackgrounds();
  });
  $("#startCardBtn").disabled = !state.backgroundId;
  $("#backgroundHint").textContent = state.backgroundId ? "已选择 1 张底图" : "请选择一张底图";
  $$('[data-bg-filter]').forEach(button => button.classList.toggle("is-active", button.dataset.bgFilter === state.backgroundFilter));
}

function renderStyles() {
  const grid = $("#styleGrid"); if (!grid) return;
  grid.innerHTML = COMIC_STYLES.map(item => `<button class="style-option${item.id === state.comicStyleId ? " is-selected" : ""}" data-comic-style="${item.id}" type="button"><div class="style-swatch" style="--a:${item.colors[0]};--b:${item.colors[1]}"><i></i><i></i><i></i></div><footer><span>${item.sample}</span><b>${item.name}</b><small>${item.desc}</small></footer></button>`).join("");
  $$('[data-comic-style]').forEach(button => button.onclick = () => { state.comicStyleId = button.dataset.comicStyle; saveState(); renderStyles(); });
  $("#startComicBtn").disabled = !state.comicStyleId;
  $("#styleHint").textContent = state.comicStyleId ? `已选择：${COMIC_STYLES.find(item => item.id === state.comicStyleId)?.name}` : "请选择一种画风";
}

async function startGeneration(type = state.materialType) {
  if (!state.selectedHook || state.hookDirty) return toast("请先确认有效钩子");
  if (type === "card" && !state.backgroundId) return toast("请先选择底图");
  if (type === "comic" && !state.comicStyleId) return toast("请先选择漫画画风");
  const payload = { selected_type: type, background_id: type === "card" ? state.backgroundId : undefined, comic_style: type === "comic" ? state.comicStyleId : undefined, simulate_failure: simulatedFailure };
  simulatedFailure = "";
  try {
    if (state.task && ["succeeded","partially_failed","failed"].includes(state.task.status) && !state.history.some(item => item.id === state.task.id)) state.history.push(clone(state.task));
    state.materialType = type;
    state.task = { id:"", project_id:state.project.id, status:"queued", progress:2, message:"正在创建生成任务…", subtasks:[{id:"material",label:type === "comic" ? "漫画图组" : "单图合成",status:"queued",message:"等待任务创建"},{id:"music",label:"BGM",status:"queued",message:"等待任务创建"}], bundle:{selected_type:type,image_assets:[]} };
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
  pollTask();
}

async function pollTask() {
  if (!state.task?.id) return;
  try {
    state.task = await api(`/api/tasks/${encodeURIComponent(state.task.id)}`);
    saveState(); renderTask();
    if (["queued", "running"].includes(state.task.status)) pollTimer = setTimeout(pollTask, 700);
    else if (["succeeded", "partially_failed"].includes(state.task.status)) { renderResult(); showPage("result"); }
  } catch (error) {
    $("#progressMessage").textContent = `状态读取失败：${error.message}`;
    pollTimer = setTimeout(pollTask, 2000);
  }
}

function renderTask() {
  const task = state.task;
  if (!task) return;
  const badge = $("#taskStatusBadge");
  badge.textContent = task.status;
  badge.dataset.status = task.status;
  $("#progressPercent").textContent = `${task.progress}%`;
  $("#progressBar").style.width = `${task.progress}%`;
  $("#progressTitle").textContent = STATUS_LABELS[task.status] || task.status;
  $("#progressMessage").textContent = task.message;
  $("#subtaskList").innerHTML = task.subtasks.map(sub => `<div class="subtask is-${escapeAttr(sub.status)}"><b>${escapeHtml(sub.label)}</b><span>${escapeHtml(STATUS_LABELS[sub.status] || sub.status)}</span><p>${escapeHtml(sub.message || "")}</p></div>`).join("");
  const retryable = ["failed", "partially_failed"].includes(task.status) && task.subtasks.some(item => item.status === "failed" && item.retryable);
  $("#retryTaskBtn").hidden = !retryable;
  $("#viewResultBtn").hidden = !["succeeded", "partially_failed"].includes(task.status);
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
  badge.textContent = task.status;
  badge.dataset.status = task.status;
  const pages = task.bundle?.image_assets || [];
  const resultType = task.bundle?.selected_type || state.materialType;
  const resultHook = task.bundle?.selected_hook_profile || state.selectedHook;
  const metadata = task.bundle?.project_metadata || { title:state.project.title, author:state.project.author, source_url:state.project.sourceUrl };
  $("#visualResultTitle").textContent = resultType === "comic" ? `连续漫画${task.bundle?.comic_style?.label ? ` · ${task.bundle.comic_style.label}` : ""}` : "单图宣传卡";
  $("#assetCount").textContent = `${pages.length} 张`;
  $("#visualResults").innerHTML = pages.map((asset, index) => {
    const source=asset.image_url||asset.background_asset_url, isComic=resultType==="comic"&&asset.panels?.length;
    const copy=isComic ? `<div class="comic-page-overlay" style="--panels:${asset.panels.length}">${asset.panels.map(panel=>`<div class="comic-panel-copy is-${escapeAttr(panel.type)}"><span>${escapeHtml(panel.text)}</span></div>`).join("")}</div>` : `<pre>${escapeHtml(asset.text)}</pre>`;
    const downloadLabel=resultType === "comic" ? `第 ${index + 1} 页` : "宣传图";
    return `<article class="visual-result"><div class="visual-canvas${isComic?" is-comic":""}" data-visual="${index}" style="--bg:${escapeAttr(asset.css_background)}">${source ? `<img src="${escapeAttr(source)}" alt="第 ${index + 1} 张视觉底图">` : ""}${copy}${asset.show_attribution ? `<small>《${escapeHtml(metadata.title)}》 · ${escapeHtml(metadata.author)} · AI 辅助 · 知乎阅读原作</small>` : ""}</div><button class="button ghost full asset-download" data-download-asset="${index}" type="button">准备${downloadLabel} PNG</button><a class="button primary full asset-download-link" data-asset-link="${index}" href="#" download hidden>下载${downloadLabel} PNG</a></article>`;
  }).join("");
  $$('[data-download-asset]').forEach(button => button.onclick = async () => { const index=Number(button.dataset.downloadAsset); setBusy(button,true,"正在生成 PNG…"); try { const url=URL.createObjectURL(await canvasBlob(pages[index])); assetObjectUrls.push(url); const link=$(`[data-asset-link="${index}"]`);link.href=url;link.download=resultType === "comic" ? `${safeName(metadata.title)}-漫画-${String(index+1).padStart(2,"0")}.png` : `${safeName(metadata.title)}-宣传图.png`;link.hidden=false;button.hidden=true;toast("PNG 已准备，请点击下载链接保存"); } catch(error) { toast(`PNG 准备失败：${error.message}`); } finally { setBusy(button,false); } });
  $("#publishCopy").textContent = resultHook.final_text;
  $("#musicPreset").textContent = task.bundle?.music_profile?.preset_label || "未生成";
  $("#musicPrompt").textContent = task.bundle?.music_profile?.prompt || "未生成";
  $("#musicNegativePrompt").textContent = task.bundle?.music_profile?.negative_prompt || "未生成";
  $("#musicPromptDetails").hidden = !task.bundle?.music_profile?.prompt;
  const music = task.subtasks.find(item => item.id === "music");
  $("#audioState").textContent = music?.message || "";
  prepareAudio(music?.status === "succeeded", task.bundle?.audio_url);
  resetVideo(music?.status === "succeeded" && pages.length > 0);
  const hasUrl = /^https?:\/\//i.test(metadata.source_url || "");
  $("#exportWarning").className = `export-warning${hasUrl ? "" : " is-error"}`;
  $("#exportWarning").textContent = hasUrl ? "发布包将包含作品署名、原作链接和 AI 辅助说明。" : "缺少有效原作链接：可以预览，但正式发布包导出已禁用。";
  $("#exportPackageBtn").disabled = !hasUrl || !pages.length;
  renderHistory();
}

function renderHistory() {
  const rows = (state.history || []).filter(item => item.id !== state.task?.id);
  $("#historyWrap").hidden = !rows.length;
  $("#historyList").innerHTML = rows.map(item => `<button class="text-button" type="button" data-history-task="${escapeAttr(item.id)}">${item.bundle?.selected_type === "comic" ? "连续漫画" : "单图宣传卡"} · ${escapeHtml(STATUS_LABELS[item.status] || item.status)}</button>`).join("");
  $$('[data-history-task]').forEach(button => button.onclick = () => { const previous=state.history.find(item=>item.id===button.dataset.historyTask); if(!previous)return; if(state.task&&!state.history.some(item=>item.id===state.task.id))state.history.push(clone(state.task)); state.task=clone(previous); state.materialType=state.task.bundle?.selected_type||state.materialType; saveState(); renderResult(); showPage("result"); });
}

function prepareAudio(available, serverUrl) {
  const button = $("#bgmPlayBtn");
  if (audioSource) { try { audioSource.stop(); } catch {} audioSource = null; }
  audioServerUrl = available && serverUrl ? serverUrl : "";
  button.hidden = !audioServerUrl;
  button.disabled = false;
  button.textContent = "试听 BGM";
}

function resetVideo(enabled) {
  if (videoObjectUrl) { URL.revokeObjectURL(videoObjectUrl); videoObjectUrl=""; }
  const video=$("#videoPreview"), link=$("#videoDownloadLink"), button=$("#buildVideoBtn");
  video.pause(); video.hidden=true; video.removeAttribute("src"); link.hidden=true; link.removeAttribute("href");
  button.disabled=!enabled;
  $("#videoState").textContent=enabled ? "点击生成后，浏览器会按 BGM 时长实时合成带声音的视频。" : "图片或 BGM 尚未成功，暂时无法合成视频。";
}

async function buildVideoPreview() {
  if (!audioServerUrl || !state.task?.bundle?.image_assets?.length) return toast("图片与 BGM 均成功后才能生成视频");
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return toast("当前浏览器不支持视频合成，请使用最新版 Chrome 或 Edge");
  const button=$("#buildVideoBtn"); setBusy(button,true,"正在实时合成…");
  try {
    const assets=state.task.bundle.image_assets;
    const bitmaps=[];
    for(const asset of assets) bitmaps.push(await createImageBitmap(await canvasBlob(asset)));
    const audioData=await fetch(audioServerUrl).then(response=>{if(!response.ok)throw new Error("BGM 读取失败");return response.arrayBuffer();});
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
    const video=$("#videoPreview"),link=$("#videoDownloadLink"); video.src=videoObjectUrl;video.hidden=false;link.href=videoObjectUrl;link.download=`${safeName(state.project.title)}-${state.task.bundle.selected_type === "comic" ? "漫画" : "宣传图"}.webm`;link.hidden=false;
    $("#videoState").textContent=`已合成 ${decoded.duration.toFixed(1)} 秒 WebM 视频（图片 + BGM）。`;
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
  if (audioSource) { audioSource.stop(); audioSource = null; button.textContent = "试听 BGM"; return; }
  if (!audioServerUrl) return;
  button.disabled = true; button.textContent = "正在载入…";
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();
    const response = await fetch(audioServerUrl); if (!response.ok) throw new Error(`音频读取失败（${response.status}）`);
    const wav = parsePcmWav(await response.arrayBuffer()), buffer = audioContext.createBuffer(wav.channels.length, wav.frames, wav.sampleRate);
    wav.channels.forEach((channel,index)=>buffer.copyToChannel(channel,index));
    const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination); audioSource = source;
    source.onended = () => { if (audioSource === source) audioSource = null; button.disabled = false; button.textContent = "试听 BGM"; };
    source.start(); button.disabled = false; button.textContent = "停止试听";
  } catch (error) { audioSource = null; button.disabled = false; button.textContent = "试听 BGM"; toast(`试听失败：${error.message}`); }
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
  if(asset.layout==="vertical_storyboard"&&asset.panels?.length) drawComicCopies(ctx,asset);
  else {ctx.fillStyle="rgba(0,0,0,.25)";ctx.fillRect(0,0,1080,1440);ctx.fillStyle="#fff";ctx.textAlign="center";ctx.font='600 48px "Microsoft YaHei"';const lines=String(asset.text).split("\n").filter(Boolean),start=610-lines.length*42;lines.forEach((line,i)=>ctx.fillText(line,540,start+i*92,820));}
  if(asset.show_attribution){const metadata=state.task?.bundle?.project_metadata||{title:state.project.title,author:state.project.author};ctx.fillStyle="rgba(0,0,0,.68)";ctx.fillRect(0,1388,1080,52);ctx.textAlign="center";ctx.textBaseline="middle";ctx.font='24px "Microsoft YaHei"';ctx.fillStyle="#fff";ctx.fillText(`《${metadata.title}》 · ${metadata.author} · AI 辅助 · 知乎阅读原作`,540,1414,980);}
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

async function exportPackage() {
  const button = $("#exportPackageBtn");
  setBusy(button, true, "正在打包…");
  try {
    if (state.task.project_id !== state.project.id) throw new Error("当前任务不属于正在编辑的项目，请返回作品页重新生成");
    await api(`/api/projects/${encodeURIComponent(state.project.id)}/export?task_id=${encodeURIComponent(state.task.id)}`);
    const entries = [];
    const assets = state.task.bundle.image_assets, resultHook = state.task.bundle?.selected_hook_profile || state.selectedHook, resultType=state.task.bundle?.selected_type || state.materialType;
    const metadata = state.task.bundle?.project_metadata || { title:state.project.title, author:state.project.author, source_url:state.project.sourceUrl };
    for (let i = 0; i < assets.length; i++) entries.push({ name: resultType === "card" ? "images/card.png" : `images/${String(i + 1).padStart(2, "0")}.png`, data: new Uint8Array(await (await canvasBlob(assets[i])).arrayBuffer()) });
    if (audioServerUrl) {
      const audio = await fetch(audioServerUrl).then(r => r.arrayBuffer());
      entries.push({ name: "audio/bgm.wav", data: new Uint8Array(audio) });
    }
    const projectJson = { exported_at: new Date().toISOString(), story: metadata, selected_hook_profile: resultHook, material_type: resultType, task: state.task };
    entries.push(textEntry("project.json", JSON.stringify(projectJson, null, 2)));
    entries.push(textEntry("README.txt", `《${metadata.title}》\n作者：${metadata.author}\n知乎原作：${metadata.source_url}\n物料：${resultType === "comic" ? "连续漫画" : "单图宣传卡"}\nAI 辅助生成，请发布前由作者复核。`));
    const packageBlob=buildZip(entries);
    const prepared=await fetch(`/api/tasks/${encodeURIComponent(state.task.id)}/package`,{method:"POST",headers:{"Content-Type":"application/zip"},body:packageBlob});
    const preparedResult=await prepared.json().catch(()=>({}));if(!prepared.ok)throw new Error(preparedResult.error||`发布包暂存失败（${prepared.status}）`);
    const link = $("#packageDownloadLink");
    link.href = preparedResult.download_url;
    link.download = `${safeName(metadata.title)}-${resultType === "comic" ? "连续漫画" : "单图宣传卡"}.zip`;
    link.hidden = false;
    toast("发布包已准备，请点击下载链接保存");
  } catch (error) { toast(`导出失败：${error.message}`); }
  finally { setBusy(button, false); }
}

function textEntry(name, text) { return { name, data: new TextEncoder().encode(text) }; }
function safeName(value) { return String(value || "story").replace(/[\\/:*?"<>|]/g, "-"); }
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const a = Object.assign(document.createElement("a"), { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function buildZip(entries) {
  const chunks = [], central = []; let offset = 0;
  const u16 = n => new Uint8Array([n & 255, n >>> 8 & 255]); const u32 = n => new Uint8Array([n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255]);
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name), crc = crc32(entry.data);
    const local = concat(u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(entry.data.length), u32(entry.data.length), u16(name.length), u16(0), name, entry.data);
    chunks.push(local);
    central.push(concat(u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(entry.data.length), u32(entry.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
    offset += local.length;
  }
  const centralData = concat(...central); const end = concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralData.length), u32(offset), u16(0));
  return new Blob([...chunks, centralData, end], { type: "application/zip" });
}
function concat(...arrays) { const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let offset = 0; arrays.forEach(a => { out.set(a, offset); offset += a.length; }); return out; }

async function importFile(file) {
  try {
    const text = file.name.toLowerCase().endsWith(".docx") ? await readDocx(file) : await file.text();
    if (!text.trim()) throw new Error("文件中没有可读取的正文");
    $("#bodyInput").value = text.trim();
    if (!$("#titleInput").value) $("#titleInput").value = file.name.replace(/\.(txt|md|markdown|docx)$/i, "");
    updateBodyCount(); syncProjectFromInputs(); toast("正文已导入");
  } catch (error) { $("#inputError").textContent = `文件解析失败：${error.message}。请改为粘贴文本。`; }
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
  if (!id) return;
  try {
    const sample = await api(`/api/samples/${encodeURIComponent(id)}`);
    $("#titleInput").value = sample.title;
    $("#authorInput").value = "授权样例作者";
    $("#bodyInput").value = sample.body;
    $("#authorizationInput").checked = true;
    state.project.labels = sample.labels || [];
    updateBodyCount(); syncProjectFromInputs(); toast("已载入授权故事正文；官方钩子不会进入生成请求");
  } catch (error) { toast(error.message); }
}

async function downloadHook() {
  try { const response = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/hooks/selected/export`); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `下载失败（${response.status}）`); downloadBlob(await response.blob(), "hook.txt"); }
  catch (error) { toast(error.message); }
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast("已复制"); } catch { toast("浏览器未开放剪贴板权限"); } }

function bindEvents() {
  ["titleInput", "authorInput", "sourceUrlInput", "authorizationInput"].forEach(id => $(`#${id}`).addEventListener("input", syncProjectFromInputs));
  $("#bodyInput").addEventListener("input", () => { updateBodyCount(); syncProjectFromInputs(); });
  $("#analyzeBtn").onclick = analyze;
  $("#hookEditor").addEventListener("input", event => { state.hookDraft = event.target.value; state.hookDirty = true; state.selectedHook = null; updateHookLength(); renderValidation(); saveState(); });
  $("#confirmHookBtn").onclick = confirmHook;
  $$('[data-material]').forEach(button => button.onclick = () => chooseMaterial(button.dataset.material));
  $("#startComicBtn").onclick = () => startGeneration("comic");
  $("#startCardBtn").onclick = () => startGeneration("card");
  $$('[data-bg-filter]').forEach(button => button.onclick = () => { state.backgroundFilter=button.dataset.bgFilter; saveState(); renderBackgrounds(); });
  $("#retryTaskBtn").onclick = retryTask;
  $("#viewResultBtn").onclick = () => { renderResult(); showPage("result"); };
  $("#copyHookBtn").onclick = () => copyText(state.selectedHook.final_text);
  $("#copyResultHookBtn").onclick = () => copyText((state.task?.bundle?.selected_hook_profile || state.selectedHook).final_text);
  $("#downloadHookBtn").onclick = downloadHook;
  $("#exportPackageBtn").onclick = exportPackage;
  $("#packageDownloadLink").onclick = () => toast("已提交浏览器下载");
  $("#bgmPlayBtn").onclick = toggleAudioPreview;
  $("#buildVideoBtn").onclick = buildVideoPreview;
  $("#otherMaterialBtn").onclick = () => showPage("action");
  $("#uploadBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = event => { const file = event.target.files[0]; if (file) importFile(file); event.target.value = ""; };
  $("#pasteBtn").onclick = async () => { try { $("#bodyInput").value = await navigator.clipboard.readText(); updateBodyCount(); syncProjectFromInputs(); } catch { toast("浏览器未开放剪贴板读取权限，请直接粘贴"); } };
  $("#sampleSelect").onchange = event => loadSample(event.target.value);
  $$('[data-action="go-input"]').forEach(button => button.onclick = event => { event.preventDefault(); showPage("input"); });
  $$('[data-action="back-hooks"]').forEach(button => button.onclick = () => { state.hookDraft = state.selectedHook.final_text; state.hookDirty = true; showPage("hooks"); renderHooks(); });
  $$('[data-action="go-action"]').forEach(button => button.onclick = () => showPage("action"));
  $$('[data-step]').forEach(button => button.onclick = () => { if (canVisit(button.dataset.step)) { if (button.dataset.step === "result") renderResult(); showPage(button.dataset.step); } });
}

window.NovelPromoWorkbench = {
  getState: () => clone(state),
  simulateNextFailure(kind = "music") { simulatedFailure = kind; return `下一次生成将模拟 ${kind} 失败`; },
  reset() { state = blankState(); saveState(); hydrateInputs(); renderAll(); },
};

init();
