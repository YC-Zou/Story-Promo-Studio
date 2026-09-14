(() => {
  "use strict";

  const STORAGE_KEY = "zhihu-story-workbench-v11";
  const W = 540, H = 720;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const params = new URLSearchParams(location.search);
  const taskId = params.get("task_id") || "";
  const assetIndex = Number(params.get("asset") || 0);
  const styles = [
    { id:"floating", name:"浮窗短句", note:"参考图式错落悬浮", description:"短句逐条出现，适合悬念与情绪递进" },
    { id:"dialogue", name:"左右对话", note:"像人物正在交锋", description:"左右气泡形成关系感，适合言情与冲突" },
    { id:"timeline", name:"线索时间轴", note:"事件一步步推进", description:"用节点建立因果顺序，适合反转与悬疑" },
    { id:"subtitle", name:"电影字幕", note:"画面优先，文字克制", description:"底部字幕保留大面积画面，适合氛围型故事" },
    { id:"paper", name:"章节纸页", note:"像一页故事摘录", description:"纸张与书页排版，适合年代、古风与现实题材" },
    { id:"impact", name:"强冲击标题", note:"先抓住最狠的一句", description:"关键词先声夺人，适合复仇、脑洞与爽点" },
  ];
  const tones = {
    cinema:"rgba(4,9,15,.42)", cool:"rgba(7,29,62,.42)", warm:"rgba(91,43,14,.28)",
    mono:"rgba(18,20,23,.50)", clear:"rgba(7,11,16,.18)"
  };

  let canvas, task, asset, design, history = [], historyIndex = -1, drawToken = 0, toastTimer;
  const autosaveKey = `poster-style-design-v2:${taskId}:${assetIndex}`;

  function toast(message) {
    const el = $("#editorToast"); el.textContent = message; el.classList.add("is-visible");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2200);
  }
  function getTask() {
    let appState; try { appState = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch {}
    return [appState?.task, ...(appState?.history || [])].filter(Boolean).find(item => item.id === taskId) || appState?.task;
  }
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
    return clean.length ? clean : ["输入一句能让人停下来的故事钩子"];
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function snapshot(render = true) {
    const json = JSON.stringify(design);
    if (history[historyIndex] !== json) {
      history = history.slice(0, historyIndex + 1); history.push(json);
      if (history.length > 30) history.shift(); historyIndex = history.length - 1;
    }
    localStorage.setItem(autosaveKey, json); $("#saveState").textContent = "已自动保存";
    updateHistory(); updateControls(); if (render) renderDesign();
  }
  function restore(index) {
    if (index < 0 || index >= history.length) return;
    historyIndex = index; design = JSON.parse(history[index]); localStorage.setItem(autosaveKey, history[index]);
    updateHistory(); updateControls(); renderDesign();
  }
  function updateHistory() { $("#undoBtn").disabled = historyIndex <= 0; $("#redoBtn").disabled = historyIndex >= history.length - 1; }
  function updateControls() {
    $$('[data-style]').forEach(button => button.classList.toggle("is-active", button.dataset.style === design.style));
    $("#linesInput").value = design.lines.join("\n"); $("#toneSelect").value = design.tone; $("#accentColor").value = design.accent;
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
    const dot = new fabric.Circle({ left:3, top:height/2-5, radius:5, fill:design.accent, stroke:"rgba(0,0,0,.35)", strokeWidth:2 });
    return decorate(new fabric.Group([rect, dot, text], { left, top, hasRotatingPoint:false, lockScalingFlip:true }), `line-${index}`);
  }
  function layoutFloating() {
    const xs = [82,132,72,120,88,145], start = design.lines.length > 5 ? 112 : 145, gap = design.lines.length > 5 ? 78 : 88;
    design.lines.forEach((line,index) => canvas.add(bubble(line,index,xs[index%xs.length],start+index*gap)));
  }
  function layoutDialogue() {
    const start = design.lines.length > 5 ? 105 : 135, gap = design.lines.length > 5 ? 83 : 94;
    design.lines.forEach((line,index) => canvas.add(bubble(line,index,index%2 ? 150 : 48,start+index*gap,index%2 ? "light" : "dark")));
  }
  function layoutTimeline() {
    const start = 125, gap = Math.min(91, 475 / Math.max(1, design.lines.length-1));
    canvas.add(lock(new fabric.Rect({ left:76, top:start+7, width:2, height:gap*(design.lines.length-1), fill:"rgba(255,255,255,.55)" })));
    design.lines.forEach((line,index) => {
      const dot = new fabric.Circle({ left:0, top:5, radius:11, fill:"rgba(20,25,31,.86)", stroke:design.accent, strokeWidth:2 });
      const num = new fabric.Text(String(index+1), { left:7, top:8, originX:"center", fontFamily:"Arial", fontSize:9, fill:"#fff" });
      const text = addText(line, { left:38, top:0, width:365, fontSize:19, fontWeight:"600" });
      canvas.add(decorate(new fabric.Group([dot,num,text], { left:66, top:start+index*gap }), `line-${index}`));
    });
  }
  function layoutSubtitle() {
    canvas.add(lock(new fabric.Rect({ left:0, top:365, width:W, height:310, fill:"rgba(5,8,12,.64)" })));
    const lead = design.lines[0] || "";
    canvas.add(decorate(addText(lead, { left:45, top:397, width:450, fontSize:31, fontWeight:"800", textAlign:"center" }), "line-0"));
    const rest = design.lines.slice(1).join("\n");
    canvas.add(decorate(addText(rest, { left:64, top:485, width:412, fontSize:18, lineHeight:1.55, textAlign:"center", fill:"rgba(255,255,255,.88)" }), "line-rest"));
    canvas.add(lock(new fabric.Rect({ left:205, top:462, width:130, height:3, rx:2, fill:design.accent })));
  }
  function layoutPaper() {
    canvas.add(lock(new fabric.Rect({ left:55, top:92, width:430, height:542, rx:3, ry:3, fill:"rgba(246,239,224,.93)", shadow:new fabric.Shadow({color:"rgba(0,0,0,.28)",blur:24,offsetY:10}) })));
    canvas.add(lock(new fabric.Text("STORY EXCERPT", { left:88, top:128, fontFamily:"Arial", fontSize:10, charSpacing:180, fill:"#8a7d6c" })));
    canvas.add(decorate(addText(design.lines.map((line,index) => `${index ? "— " : ""}${line}`).join("\n\n"), { left:88, top:180, width:364, fontFamily:"KaiTi", fontSize:20, lineHeight:1.5, fill:"#292823" }), "paper-copy"));
    canvas.add(lock(new fabric.Rect({ left:88, top:158, width:54, height:3, fill:design.accent })));
  }
  function layoutImpact() {
    const first = design.lines[0] || "", second = design.lines[1] || "";
    canvas.add(decorate(addText(first, { left:38, top:105, width:455, fontSize:43, lineHeight:1.08, fontWeight:"900" }), "line-0"));
    if (second) canvas.add(decorate(addText(second, { left:38, top:218, width:445, fontSize:35, lineHeight:1.12, fontWeight:"850", fill:design.accent }), "line-1"));
    const rest = design.lines.slice(2);
    rest.forEach((line,index) => canvas.add(bubble(line,index+2,index%2 ? 105 : 58,345+index*75)));
  }
  function compose() {
    canvas.add(lock(new fabric.Rect({ left:0, top:0, width:W, height:H, fill:tones[design.tone] || tones.cinema })));
    addHeader();
    ({ floating:layoutFloating, dialogue:layoutDialogue, timeline:layoutTimeline, subtitle:layoutSubtitle, paper:layoutPaper, impact:layoutImpact }[design.style] || layoutFloating)();
    addAttribution(); canvas.requestRenderAll();
  }
  function renderDesign() {
    const token = ++drawToken; canvas.clear(); canvas.backgroundColor = "#303943";
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
      $("#backgroundList").innerHTML = (result.backgrounds || []).map(item => `<button class="background-choice" data-background="${item.asset_url}" type="button"><img src="${item.thumbnail_url}" alt="${item.name}"><span>${item.recommended ? "★ " : ""}${item.name}</span></button>`).join("");
      $$('[data-background]').forEach(button => button.onclick = () => { design.backgroundUrl = button.dataset.background; snapshot(); toast("底图已替换"); }); updateControls();
    } catch { $("#backgroundList").textContent = "底图库载入失败"; }
  }
  function bind() {
    $("#applyCopyBtn").onclick = () => { design.lines = splitCopy($("#linesInput").value); design.positions = {}; snapshot(); toast("分句已应用"); };
    $("#toneSelect").onchange = event => { design.tone = event.target.value; snapshot(); };
    $("#accentColor").onchange = event => { design.accent = event.target.value; snapshot(); };
    $("#resetLayoutBtn").onclick = () => { design.positions = {}; snapshot(); toast("已恢复推荐排版"); };
    $("#undoBtn").onclick = () => restore(historyIndex - 1); $("#redoBtn").onclick = () => restore(historyIndex + 1);
    $("#exportBtn").onclick = () => {
      canvas.discardActiveObject(); canvas.requestRenderAll();
      const url = canvas.toDataURL({ format:"png", multiplier:2, enableRetinaScaling:false });
      const filename = `${String(task.bundle?.project_metadata?.title || "故事").replace(/[\\/:*?"<>|]/g,"-")}-${styles.find(item=>item.id===design.style)?.name || "宣传图"}.png`;
      const link = Object.assign(document.createElement("a"), { href:url, download:filename }); document.body.append(link); link.click(); link.remove(); toast("已生成 1080 × 1440 高清宣传图");
    };
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); restore(historyIndex + (event.shiftKey ? 1 : -1)); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); restore(historyIndex + 1); }
    });
  }
  function boot() {
    if (!window.fabric) return alert("宣传图编辑组件载入失败");
    task = getTask(); asset = task?.bundle?.image_assets?.[assetIndex];
    if (!task || task.bundle?.selected_type !== "card" || !asset) { $("#saveState").textContent = "未找到可编辑的宣传图"; $("#exportBtn").disabled = true; return; }
    $("#posterName").textContent = `《${task.bundle?.project_metadata?.title || "故事"}》宣传图`;
    canvas = new fabric.Canvas("posterCanvas", { width:W, height:H, preserveObjectStacking:true, selection:false });
    canvas.on("object:modified", event => {
      const key = event.target?.designKey; if (!key) return;
      design.positions ||= {}; design.positions[design.style] ||= {}; design.positions[design.style][key] = { left:event.target.left, top:event.target.top }; snapshot(false);
    });
    const saved = localStorage.getItem(autosaveKey);
    try { design = saved ? JSON.parse(saved) : null; } catch { design = null; }
    design ||= { style:"floating", lines:splitCopy(asset.text || task.bundle?.selected_hook_profile?.final_text), backgroundUrl:asset.image_url || asset.background_asset_url || "", tone:"cinema", accent:"#ffffff", positions:{} };
    history = [JSON.stringify(design)]; historyIndex = 0;
    renderStyles(); bind(); updateHistory(); updateControls(); renderBackgrounds(); renderDesign();
    $("#saveState").textContent = saved ? "已恢复上次设计" : "已自动保存";
    $("#canvasShell").style.setProperty("--zoom", window.innerWidth < 980 ? ".68" : ".78");
  }

  boot();
})();
