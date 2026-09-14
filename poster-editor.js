(() => {
  "use strict";

  const STORAGE_KEY = "zhihu-story-workbench-v11";
  const W = 540, H = 720;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const params = new URLSearchParams(location.search);
  const draftMode = params.get("mode") === "draft";
  const taskId = params.get("task_id") || "";
  const assetIndex = Number(params.get("asset") || 0);
  const styles = [
    { id:"floating", name:"浮窗短句", note:"参考图式错落悬浮", description:"短句逐条出现，适合悬念与情绪递进" },
    { id:"fragments", name:"悬念便签", note:"像散落的故事碎片", description:"纸片式短句制造翻阅感，适合秘密与回忆" },
    { id:"timeline", name:"线索时间轴", note:"事件一步步推进", description:"用节点建立因果顺序，适合反转与悬疑" },
    { id:"subtitle", name:"电影字幕", note:"画面优先，文字克制", description:"底部字幕保留大面积画面，适合氛围型故事" },
    { id:"paper", name:"章节纸页", note:"像一页故事摘录", description:"纸张与书页排版，适合年代、古风与现实题材" },
    { id:"impact", name:"强冲击标题", note:"先抓住最狠的一句", description:"关键词先声夺人，适合复仇、脑洞与爽点" },
  ];
  const tones = {
    cinema:"rgba(4,9,15,.42)", cool:"rgba(7,29,62,.42)", warm:"rgba(91,43,14,.28)",
    mono:"rgba(18,20,23,.50)", clear:"rgba(7,11,16,.18)"
  };

  let canvas, task, asset, design, appState, history = [], historyIndex = -1, drawToken = 0, toastTimer, renderReady = false, savedForReturn = false;

  function toast(message) {
    const el = $("#editorToast"); el.textContent = message; el.classList.add("is-visible");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2200);
  }
  function getTask() {
    try { appState = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY) || "null"); } catch {}
    if (draftMode) {
      const background = appState?.backgrounds?.find(item => item.id === appState.backgroundId);
      if (!appState?.selectedHook || !background) return null;
      return { project_id:appState.project.id, bundle:{ selected_type:"card", project_metadata:{ title:appState.project.title, author:appState.project.author, source_url:appState.project.sourceUrl }, selected_hook_profile:appState.selectedHook, visual_context:{ primary_category:appState.analysis?.story_profile?.primary_category }, image_assets:[{ text:appState.selectedHook.final_text, background_id:background.id, background_asset_url:background.asset_url }] } };
    }
    return [appState?.task, ...(appState?.history || [])].filter(Boolean).find(item => item.id === taskId) || appState?.task;
  }
  function stripPunctuation(value) { return String(value || "").replace(/[，。！？；：、,.!?;:"“”‘’（）()【】《》〈〉—…·~～\-]/gu, "").trim(); }
  function splitCopy(value) {
    const source = String(value || "").replace(/\r/g, "").trim();
    let rows = source.split(/\n+/).map(row => row.trim()).filter(Boolean);
    if (rows.length < 4) rows = source.split(/(?<=[，。！？；])/).map(row => row.trim()).filter(Boolean);
    const expanded = [];
    rows.forEach(row => {
      if (row.length <= 22) return expanded.push(row);
      const chunks = row.split(/(?<=[，、：；])/).map(item => item.trim()).filter(Boolean);
      if (chunks.length > 1) expanded.push(...chunks); else for (let i=0; i<row.length; i+=18) expanded.push(row.slice(i,i+18));
    });
    const clean = (expanded.length ? expanded : rows).slice(0, 6);
    const stripped = clean.map(stripPunctuation).filter(Boolean);
    return stripped.length ? stripped : ["输入一句能让人停下来的故事钩子"];
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function snapshot(render = true) {
    const json = JSON.stringify(design);
    if (history[historyIndex] !== json) {
      history = history.slice(0, historyIndex + 1); history.push(json);
      if (history.length > 30) history.shift(); historyIndex = history.length - 1;
    }
    savedForReturn = false;
    $("#saveState").textContent = "有未保存修改";
    $("#backBtn").disabled = true;
    updateControls(); if (render) renderDesign();
  }
  function restore(index) {
    if (index < 0 || index >= history.length) return;
    historyIndex = index; design = JSON.parse(history[index]); savedForReturn = false;
    $("#saveState").textContent = "有未保存修改"; $("#backBtn").disabled = true;
    updateControls(); renderDesign();
  }
  function updateControls() {
    $$('[data-style]').forEach(button => button.classList.toggle("is-active", button.dataset.style === design.style));
    $("#linesInput").value = design.lines.join("\n"); $("#toneSelect").value = design.tone;
    const current = styles.find(item => item.id === design.style); $("#styleDescription").textContent = current?.description || "";
    $$('[data-background]').forEach(button => button.classList.toggle("is-active", button.dataset.background === design.backgroundUrl));
  }
  function lock(obj) { obj.set({ selectable:false, evented:false }); return obj; }
  function decorate(obj, key) {
    obj.designKey = key; obj.set({ cornerColor:"#fff", cornerStrokeColor:"#1768e9", borderColor:"#fff", cornerStyle:"circle", transparentCorners:false, padding:5 });
    const saved = design.positions?.[design.style]?.[key]; if (saved) obj.set({ left:saved.left, top:saved.top });
    return obj;
  }
  function addText(text, options = {}) {
    return new fabric.Textbox(text, { fontFamily:"Microsoft YaHei", splitByGrapheme:true, fill:"#fff", fontSize:20, lineHeight:1.25, ...options });
  }
  function fittedText(text, options, maxHeight, minSize = 18) {
    const box = addText(text, options); let size = Number(box.fontSize) || 20;
    box.initDimensions();
    while (box.height > maxHeight && size > minSize) { size -= 1; box.set({ fontSize:size }); box.initDimensions(); }
    return box;
  }
  function addHeader() {
    const title = task.bundle?.project_metadata?.title || "故事";
    canvas.add(lock(new fabric.Text(`STORY  /  《${title}》`, { left:30, top:27, fontFamily:"Arial", fontSize:10, fontWeight:"700", charSpacing:90, fill:"rgba(255,255,255,.78)" })));
  }
  function addAttribution() {
    const meta = task.bundle?.project_metadata || {};
    canvas.add(lock(new fabric.Rect({ left:0, top:675, width:W, height:45, fill:"rgba(6,9,13,.76)" })));
    canvas.add(lock(addText(`《${meta.title || "作品"}》 · ${meta.author || "作者"} · AI 辅助 · 知乎阅读原作`, { left:28, top:691, width:484, fontSize:9, textAlign:"center", fill:"rgba(255,255,255,.82)" })));
  }
  function bubble(line, index, left, top, variant = "dark") {
    const width = Math.min(390, Math.max(155, line.length * 19 + 32));
    const text = addText(line, { left:39, top:10, width:width-32, fontSize:18, fontWeight:"500", fill:variant === "light" ? "#1d2732" : "#fff" });
    const height = Math.max(39, text.height + 20);
    const rect = new fabric.Rect({ left:26, top:0, width, height, rx:height/2, ry:height/2, fill:variant === "light" ? "rgba(255,255,255,.88)" : "rgba(19,23,29,.78)", stroke:"rgba(255,255,255,.42)", strokeWidth:1 });
    const dot = new fabric.Circle({ left:3, top:height/2-5, radius:5, fill:"#fff", stroke:"rgba(0,0,0,.35)", strokeWidth:2 });
    return decorate(new fabric.Group([rect, dot, text], { left, top, hasRotatingPoint:false, lockScalingFlip:true }), `line-${index}`);
  }
  function layoutFloating() {
    const xs = [82,132,72,120,88,145], start = design.lines.length > 5 ? 112 : 145, gap = design.lines.length > 5 ? 78 : 88;
    design.lines.forEach((line,index) => canvas.add(bubble(line,index,xs[index%xs.length],start+index*gap)));
  }
  function layoutFragments() {
    const xs = [56,138,82,125,62,148], angles = [-2,2,-1,2,-2,1], start = design.lines.length > 5 ? 105 : 135, gap = design.lines.length > 5 ? 82 : 92;
    design.lines.forEach((line,index) => {
      const width = Math.min(385, Math.max(190, line.length * 18 + 42));
      const text = addText(line, { left:18, top:13, width:width-36, fontFamily:"KaiTi", fontSize:18, fontWeight:"600", fill:"#292823" });
      const height = Math.max(48, text.height + 26);
      const paper = new fabric.Rect({ left:0, top:0, width, height, rx:3, ry:3, fill:"rgba(246,239,224,.94)", shadow:new fabric.Shadow({color:"rgba(0,0,0,.22)",blur:10,offsetY:4}) });
      canvas.add(decorate(new fabric.Group([paper,text], { left:xs[index%xs.length], top:start+index*gap, angle:angles[index%angles.length] }), `line-${index}`));
    });
  }
  function layoutTimeline() {
    const start = 125, gap = Math.min(91, 475 / Math.max(1, design.lines.length-1));
    canvas.add(lock(new fabric.Rect({ left:76, top:start+7, width:2, height:gap*(design.lines.length-1), fill:"rgba(255,255,255,.55)" })));
    design.lines.forEach((line,index) => {
      const dot = new fabric.Circle({ left:0, top:5, radius:11, fill:"rgba(20,25,31,.86)", stroke:"#fff", strokeWidth:2 });
      const num = new fabric.Text(String(index+1), { left:7, top:8, originX:"center", fontFamily:"Arial", fontSize:9, fill:"#fff" });
      const text = addText(line, { left:38, top:0, width:365, fontSize:19, fontWeight:"600" });
      canvas.add(decorate(new fabric.Group([dot,num,text], { left:66, top:start+index*gap }), `line-${index}`));
    });
  }
  function layoutSubtitle() {
    canvas.add(lock(new fabric.Rect({ left:0, top:365, width:W, height:310, fill:"rgba(5,8,12,.64)" })));
    const articleTitle = task.bundle?.project_metadata?.title || "故事";
    canvas.add(decorate(fittedText(`《${articleTitle}》`, { left:45, top:397, width:450, fontSize:31, fontWeight:"800", textAlign:"center" }, 55, 22), "article-title"));
    const hookCopy = design.lines.join("\n");
    canvas.add(decorate(fittedText(hookCopy, { left:64, top:485, width:412, fontSize:18, lineHeight:1.55, textAlign:"center", fill:"rgba(255,255,255,.88)" }, 165, 14), "hook-copy"));
    canvas.add(lock(new fabric.Rect({ left:205, top:462, width:130, height:3, rx:2, fill:"#fff" })));
  }
  function layoutPaper() {
    const articleTitle = task.bundle?.project_metadata?.title || "故事";
    canvas.add(lock(new fabric.Rect({ left:55, top:92, width:430, height:542, rx:3, ry:3, fill:"rgba(246,239,224,.93)", shadow:new fabric.Shadow({color:"rgba(0,0,0,.28)",blur:24,offsetY:10}) })));
    canvas.add(lock(fittedText(`《${articleTitle}》`, { left:88, top:121, width:364, fontFamily:"KaiTi", fontSize:22, fontWeight:"700", fill:"#6f6252" }, 35, 16)));
    canvas.add(decorate(addText(design.lines.join("\n\n"), { left:88, top:180, width:364, fontFamily:"KaiTi", fontSize:20, lineHeight:1.5, fill:"#292823" }), "paper-copy"));
    canvas.add(lock(new fabric.Rect({ left:88, top:158, width:54, height:3, fill:"#8a7d6c" })));
  }
  function layoutImpact() {
    const articleTitle = task.bundle?.project_metadata?.title || "故事";
    const lead = design.lines[0] || "";
    canvas.add(decorate(fittedText(`《${articleTitle}》`, { left:38, top:92, width:455, fontSize:43, lineHeight:1.08, fontWeight:"900" }, 100, 26), "article-title"));
    if (lead) canvas.add(decorate(fittedText(lead, { left:38, top:218, width:445, fontSize:31, lineHeight:1.12, fontWeight:"850", fill:"#fff" }, 82, 22), "line-0"));
    const rest = design.lines.slice(1);
    rest.forEach((line,index) => canvas.add(bubble(line,index+1,index%2 ? 105 : 58,330+index*67)));
  }
  function compose() {
    canvas.add(lock(new fabric.Rect({ left:0, top:0, width:W, height:H, fill:tones[design.tone] || tones.cinema })));
    addHeader();
    ({ floating:layoutFloating, fragments:layoutFragments, timeline:layoutTimeline, subtitle:layoutSubtitle, paper:layoutPaper, impact:layoutImpact }[design.style] || layoutFloating)();
    addAttribution(); canvas.requestRenderAll(); renderReady = true;
  }
  function renderDesign() {
    const token = ++drawToken; renderReady = false; canvas.clear(); canvas.backgroundColor = "#303943";
    const url = design.backgroundUrl;
    if (!url) return compose();
    fabric.Image.fromURL(url, image => {
      if (token !== drawToken) return;
      const scale = Math.max(W / image.width, H / image.height);
      image.set({ left:W/2, top:H/2, originX:"center", originY:"center", scaleX:scale, scaleY:scale, selectable:false, evented:false });
      if (design.tone === "mono") image.filters = [new fabric.Image.filters.Grayscale()];
      image.applyFilters(); canvas.add(image); compose();
    }, { crossOrigin:"anonymous" });
  }
  function renderStyles() {
    $("#styleList").innerHTML = styles.map(item => `<button class="style-card" data-style="${item.id}" type="button"><div class="mini mini-${item.id}"><i></i><i></i><i></i></div><strong>${item.name}</strong><small>${item.note}</small></button>`).join("");
    $$('[data-style]').forEach(button => button.onclick = () => { design.style = button.dataset.style; design.positions = {}; snapshot(); });
  }
  async function renderBackgrounds() {
    try {
      const category = task.bundle?.visual_context?.primary_category || "realistic_emotion";
      const result = await fetch(`/api/backgrounds?category=${encodeURIComponent(category)}&project_id=${encodeURIComponent(task.project_id)}`).then(response => response.json());
      $("#backgroundList").innerHTML = (result.backgrounds || []).map(item => `<button class="background-choice" data-background="${item.asset_url}" data-background-id="${item.id}" type="button"><img src="${item.thumbnail_url}" alt="${item.name}"><span>${item.recommended ? "★ " : ""}${item.name}</span></button>`).join("");
      $$('[data-background]').forEach(button => button.onclick = () => { design.backgroundUrl = button.dataset.background; design.backgroundId = button.dataset.backgroundId; snapshot(); toast("底图已替换"); }); updateControls();
    } catch { $("#backgroundList").textContent = "底图库载入失败"; }
  }
  function bind() {
    $("#applyCopyBtn").onclick = () => { design.lines = splitCopy($("#linesInput").value); design.positions = {}; snapshot(); toast("分句已应用"); };
    $("#toneSelect").onchange = event => { design.tone = event.target.value; snapshot(); };
    $("#resetLayoutBtn").onclick = () => { design.positions = {}; snapshot(); toast("已恢复推荐排版"); };
    $("#saveBtn").onclick = () => {
      if (!renderReady) return toast("画面仍在载入，请稍候再保存");
      canvas.discardActiveObject(); canvas.requestRenderAll();
      const current = styles.find(item => item.id === design.style);
      const previewDataUrl = canvas.toDataURL({ format:"jpeg", quality:.86, multiplier:2, enableRetinaScaling:false });
      const backgroundId = design.backgroundId || asset.background_id;
      appState.backgroundId = backgroundId;
      appState.posterDesign = { ...clone(design), styleName:current?.name || "宣传图定稿", backgroundId, previewDataUrl, savedAt:Date.now() };
      appState.page = "background";
      const value = JSON.stringify(appState);
      try { sessionStorage.setItem(STORAGE_KEY,value); localStorage.setItem(STORAGE_KEY,value); }
      catch { return toast("浏览器存储空间不足，暂时无法保存这张定稿"); }
      savedForReturn = true;
      $("#saveState").textContent = "已保存，可以返回";
      $("#backBtn").disabled = false;
      toast("定稿已保存，请点击返回开始生成");
    };
    $("#backBtn").onclick = () => {
      if (!savedForReturn) return toast("请先保存当前定稿");
      location.href = "./?start_card=1";
    };
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); restore(historyIndex + (event.shiftKey ? 1 : -1)); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); restore(historyIndex + 1); }
    });
  }
  function boot() {
    if (!window.fabric) return alert("宣传图编辑组件载入失败");
    task = getTask(); asset = task?.bundle?.image_assets?.[assetIndex];
    if (!task || task.bundle?.selected_type !== "card" || !asset) { $("#saveState").textContent = "未找到可编辑的宣传图"; $("#saveBtn").disabled = true; return; }
    $("#posterName").textContent = `《${task.bundle?.project_metadata?.title || "故事"}》宣传图`;
    canvas = new fabric.Canvas("posterCanvas", { width:W, height:H, preserveObjectStacking:true, selection:false });
    canvas.on("object:modified", event => {
      const key = event.target?.designKey; if (!key) return;
      design.positions ||= {}; design.positions[design.style] ||= {}; design.positions[design.style][key] = { left:event.target.left, top:event.target.top }; snapshot(false);
    });
    const saved = appState?.posterDesign?.backgroundId === asset.background_id ? JSON.stringify(appState.posterDesign) : "";
    try { design = saved ? JSON.parse(saved) : null; } catch { design = null; }
    if (design?.style === "dialogue") design.style = "fragments";
    if (design) { delete design.previewDataUrl; delete design.savedAt; delete design.styleName; delete design.accent; }
    design ||= { style:"floating", lines:splitCopy(asset.text || task.bundle?.selected_hook_profile?.final_text), backgroundId:asset.background_id, backgroundUrl:asset.image_url || asset.background_asset_url || "", tone:"cinema", positions:{} };
    design.backgroundId ||= asset.background_id;
    design.lines = splitCopy(design.lines.join("\n"));
    history = [JSON.stringify(design)]; historyIndex = 0;
    renderStyles(); bind(); updateControls(); renderBackgrounds(); renderDesign();
    $("#saveState").textContent = "尚未保存";
    $("#canvasShell").style.setProperty("--zoom", window.innerWidth < 980 ? ".68" : ".78");
  }

  boot();
})();
