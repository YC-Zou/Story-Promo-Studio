import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port=43173;
for(const file of ["server.mjs","app.js","poster-editor.js"])execFileSync(process.execPath,["--check",file],{stdio:"inherit"});
const html=await readFile("index.html","utf8");
for(const forbidden of ["推荐分","适配评分","AI Prompt","Negative Prompt",">queued<",">succeeded<"])if(html.includes(forbidden))throw new Error(`用户界面仍包含内部文案：${forbidden}`);
for(const file of ["index.html","styles.css","app.js","poster-editor.html","poster-editor.css","poster-editor.js","third_party/fabric/fabric.min.js"])await access(file);
const runtime=await mkdtemp(join(tmpdir(),"story-promo-test-"));
const server=spawn(process.execPath,[resolve("server.mjs")],{env:{...process.env,PORT:String(port),APP_MODE:"test",NODE_ENV:"test",RUNTIME_DIR:runtime,OPENAI_API_KEY:"",OPENAI_NEXT_API_KEY:""},stdio:["ignore","pipe","pipe"]});
let stderr="";server.stderr.on("data",chunk=>stderr+=chunk);
try{
  let ready=false;
  for(let attempt=0;attempt<50&&!ready;attempt++){
    await new Promise(resolve=>setTimeout(resolve,100));
    try{ready=(await fetch(`http://127.0.0.1:${port}/api/health`)).ok;}catch{}
  }
  if(!ready)throw new Error(`隔离测试服务启动失败：${stderr}`);
  await new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,[resolve("tests/smoke.mjs")],{env:{...process.env,TEST_BASE_URL:`http://127.0.0.1:${port}`},stdio:"inherit"});
    child.on("exit",code=>code===0?resolvePromise():reject(new Error(`接口测试失败（${code}）`)));
  });

  const demoPort=43174,demoRuntime=await mkdtemp(join(tmpdir(),"story-promo-demo-test-"));
  const demoServer=spawn(process.execPath,[resolve("server.mjs")],{env:{...process.env,PORT:String(demoPort),APP_MODE:"demo",RUNTIME_DIR:demoRuntime,OPENAI_API_KEY:"",OPENAI_NEXT_API_KEY:""},stdio:["ignore","pipe","pipe"]});
  try{
    for(let attempt=0;attempt<50;attempt++){try{if((await fetch(`http://127.0.0.1:${demoPort}/api/health`)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    const base=`http://127.0.0.1:${demoPort}`,sampleList=await fetch(`${base}/api/samples`).then(response=>response.json()),sample=await fetch(`${base}/api/samples/${sampleList.samples[0].work_id}`).then(response=>response.json());
    const analyzed=await fetch(`${base}/api/projects/analyze`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:sample.title,author:sample.author_name,source_url:"",authorized:true,body:sample.body,labels:sample.labels,sample_id:sample.work_id})}).then(response=>response.json());
    const candidate=analyzed.candidates[0],selected=await fetch(`${base}/api/projects/${analyzed.story_profile.project_id}/select-hook`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({candidate_id:candidate.candidate_id,final_text:candidate.rendered_text})});
    if(!selected.ok)throw new Error("演示模式文案确认失败");
    const backgrounds=await fetch(`${base}/api/backgrounds?category=${analyzed.story_profile.primary_category}`).then(response=>response.json());
    const rejected=await fetch(`${base}/api/projects/${analyzed.story_profile.project_id}/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selected_type:"card",background_id:backgrounds.backgrounds[0].id,simulate_failure:"music"})});
    if(rejected.status!==400)throw new Error(`演示/生产接口应拒绝 simulate_failure，实际 ${rejected.status}`);
    const generated=await fetch(`${base}/api/projects/${analyzed.story_profile.project_id}/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selected_type:"card",background_id:backgrounds.backgrounds[0].id,music_enabled:false})}).then(response=>response.json());
    let completed;
    for(let attempt=0;attempt<40;attempt++){
      completed=await fetch(`${base}/api/tasks/${generated.id}`).then(response=>response.json());
      if(completed.status==="succeeded")break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(completed?.status!=="succeeded")throw new Error("演示模式素材未完成");
    const exportInfo=await fetch(`${base}/api/projects/${analyzed.story_profile.project_id}/export?task_id=${generated.id}`).then(response=>response.json());
    if(!exportInfo.download_url)throw new Error("无原作链接的授权样例未能导出演示包");
    const tinyPng=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
    const image=await fetch(`${base}/api/tasks/${generated.id}/final-images/0`,{method:"POST",headers:{"Content-Type":"image/png"},body:tinyPng});
    if(image.status!==201)throw new Error("演示模式最终图片保存失败");
    const packageResponse=await fetch(`${base}${exportInfo.download_url}`);
    const packageText=Buffer.from(await packageResponse.arrayBuffer()).toString("utf8");
    if(packageResponse.status!==200||!packageText.includes("演示说明.txt")||!packageText.includes('"demo_only": true'))throw new Error("演示包未明确标注仅供体验");
  }finally{demoServer.kill();await rm(demoRuntime,{recursive:true,force:true});}
}finally{
  server.kill();
  await rm(runtime,{recursive:true,force:true});
}
