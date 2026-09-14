import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const base=process.env.WORKBENCH_BASE_URL||"http://127.0.0.1:4173";
const key=process.env.OPENAI_NEXT_API_KEY||process.env.OPENAI_API_KEY;
if(!key)throw new Error("Missing OPENAI_NEXT_API_KEY / OPENAI_API_KEY");
const apiBase=(process.env.OPENAI_BASE_URL||"https://api.openai-next.com/v1").replace(/\/$/,"");
const model=process.env.HOOK_MODEL||"gpt-5.6-sol";
const benchmarkPath=process.env.BENCHMARK_PATH||resolve(root,"..","..","..","https-www-zhihu-com-parker-campaign-2","outputs","hook_generation","official_20_hook_generation_benchmark.jsonl");
const rows=(await readFile(benchmarkPath,"utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const choices=[
  [2,"悬疑/惊悚·犯罪追杀"],
  [5,"言情·关系冲突与身份反差"],
  [19,"复仇逆袭·修真武器反差"],
  [13,"脑洞高概念·喜剧修仙"],
  [16,"现实情感·末日亲情"],
];

async function post(path,body){
  let last;
  for(let attempt=0;attempt<3;attempt++)try{
    const payload=JSON.stringify(body),target=new URL(base+path);
    const {status,value}=await new Promise((resolveRequest,rejectRequest)=>{const request=httpRequest({hostname:target.hostname,port:target.port,path:target.pathname+target.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)}},response=>{const chunks=[];response.on("data",chunk=>chunks.push(chunk));response.on("end",()=>{let value={};try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{}resolveRequest({status:response.statusCode||0,value});});});request.on("error",rejectRequest);request.setTimeout(0);request.end(payload);});
    if(status<200||status>=300)throw new Error(`${path}: ${value.error||status} ${JSON.stringify(value.details||[])}`);
    return value;
  }catch(error){last=error;process.stderr.write(`RETRY ${path} ${attempt+1}: ${error.message}\n`);if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1500));}
  throw last;
}
function parseJson(text){const cleaned=String(text||"").replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"" ).trim();try{return JSON.parse(cleaned);}catch{const a=cleaned.indexOf("{"),b=cleaned.lastIndexOf("}");if(a>=0&&b>a)return JSON.parse(cleaned.slice(a,b+1));throw new Error("judge returned invalid JSON");}}
async function judge(row,analysis){
  const candidates=analysis.candidates.map(candidate=>({candidate_id:candidate.candidate_id,rendered_text:candidate.rendered_text,hook_type:candidate.hook_type,source_refs:candidate.lines.flatMap(line=>line.source_refs)}));
  const prompt=`你是独立的知乎故事宣发质检编辑。不得采用候选自带评分作为结论。请逐句对照完整正文、官方钩子和实际三个候选，进行人工式审查，只返回 JSON。\n判断“与官方钩子吻合”不要求逐字相似；相同或高度相关核心卖点、未改变人物关系事件因果、未提前泄露官方保留答案、题材语气与情绪方向一致、形成相近续读动机即可。\n输出结构：{"candidate_reviews":[{"candidate_id":"C1","fact_error":false,"fact_error_details":[],"boundary_spoiler":false,"spoiler_details":[],"unique_selling_point_covered":true,"cold_reader_clear":true,"person_and_genre_tone_consistent":true,"opening_rhythm_and_stop_natural":true,"evidence_sufficient":true,"issues":[]}],"best_review":{"candidate_id":"C1","official_alignment":{"core_selling_point":true,"scene_selection":true,"narrative_angle":true,"emotional_payoff":true,"overall":true},"continuation_motivation_similar":true,"editorial_conclusion":"一句具体结论"}}。candidate_reviews 必须正好三项。任何无法从正文支持的断言都算事实错误；真凶、终局反转、最终胜负、最终判决、最终归宿等官方钩子刻意保留内容算越界剧透。\n作品：${row.title}\n标签：${row.labels.join("、")}\n官方钩子：${row.gold_hook}\n正文：${row.body}\n证据池：${JSON.stringify(analysis.content_analysis.evidence_pool)}\n实际候选：${JSON.stringify(candidates)}\n默认最佳：${analysis.best_candidate_id}`;
  let last;
  for(let attempt=0;attempt<2;attempt++)try{
    const response=await fetch(`${apiBase}/chat/completions`,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model,messages:[{role:"user",content:prompt}],response_format:{type:"json_object"},reasoning_effort:"low",temperature:0,max_tokens:2400}),signal:AbortSignal.timeout(600000)});
    const value=await response.json().catch(()=>({}));if(!response.ok)throw new Error(value.error?.message||`judge HTTP ${response.status}`);
    const parsed=parseJson(value.choices?.[0]?.message?.content);if(parsed.candidate_reviews?.length!==3)throw new Error("judge review count invalid");return parsed;
  }catch(error){last=error;}
  throw last;
}

const outDir=process.env.BENCHMARK_OUTPUT_DIR?resolve(root,process.env.BENCHMARK_OUTPUT_DIR):resolve(root,"work","hook-benchmark-5"), checkpointPath=resolve(outDir,"checkpoint.json");await mkdir(outDir,{recursive:true});
let results=[];try{results=JSON.parse(await readFile(checkpointPath,"utf8")).results||[];}catch{}
const rerunCases=new Set(String(process.env.BENCHMARK_RERUN_CASES||"").split(",").map(value=>Number(value.trim())).filter(Number.isFinite));
if(rerunCases.size)results=results.filter(item=>!rerunCases.has(item.data_no));
for(const [index,genre] of choices){
  if(results.some(item=>item.data_no===index+1)){process.stdout.write(`SKIP ${index+1} checkpoint\n`);continue;}
  const row=rows[index];process.stdout.write(`ANALYZE ${index+1} ${row.title}\n`);
  const analysis=await post("/api/projects/analyze",{title:row.title,author:row.author_name||"官方测试作者",source_url:`https://www.zhihu.com/question/1/answer/${index+1}`,authorized:true,body:row.body,labels:row.labels});
  process.stdout.write(`JUDGE ${index+1} ${analysis.best_candidate_id}\n`);
  const review=await judge(row,analysis);
  const evidenceById=Object.fromEntries(analysis.content_analysis.evidence_pool.map(item=>[item.ref_id,item]));
  results.push({data_no:index+1,genre,work_id:row.work_id,title:row.title,labels:row.labels,official_hook:row.gold_hook,model:analysis.adapter_mode==="live_model"?model:analysis.adapter_mode,candidates:analysis.candidates.map(candidate=>({candidate_id:candidate.candidate_id,hook_type:candidate.hook_type,strategy:candidate.strategy,text:candidate.rendered_text,evidence:[...new Set(candidate.lines.flatMap(line=>line.source_refs))].map(ref_id=>evidenceById[ref_id])})),best_candidate_id:analysis.best_candidate_id,best_candidate:analysis.candidates.find(item=>item.candidate_id===analysis.best_candidate_id)?.rendered_text,content_analysis:analysis.content_analysis,independent_review:review});
  await writeFile(checkpointPath,JSON.stringify({updated_at:new Date().toISOString(),results},null,2)+"\n","utf8");
}
const failed=results.flatMap(item=>item.independent_review.candidate_reviews.map(review=>({title:item.title,...review}))).filter(item=>item.fact_error||item.boundary_spoiler);
const officialMismatch=results.filter(item=>!item.independent_review.best_review?.official_alignment?.overall);
const report={generated_at:new Date().toISOString(),selection_basis:"覆盖悬疑惊悚、言情关系、复仇逆袭、脑洞喜剧、现实亲情五种明显不同题材和语气",model,all_candidates_fact_and_spoiler_passed:failed.length===0,all_best_official_direction_aligned:officialMismatch.length===0,failed_reviews:failed,official_mismatches:officialMismatch.map(item=>item.title),results};
await writeFile(resolve(outDir,"report.json"),JSON.stringify(report,null,2)+"\n","utf8");
process.stdout.write(JSON.stringify({cases:results.length,fact_or_spoiler_failures:failed.length,official_mismatches:officialMismatch.length,report:resolve(outDir,"report.json")},null,2)+"\n");
if(failed.length||officialMismatch.length)process.exitCode=2;
