import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const apiKey = process.env.OPENAI_NEXT_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Missing OPENAI_NEXT_API_KEY / OPENAI_API_KEY");

const apiBase = (process.env.SEEDREAM_BASE_URL || "https://api.openai-next.com/v1").replace(/\/$/, "");
const model = process.env.SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628";
const outputDir = resolve(process.argv[2] || "assets/preset-backgrounds/library");
const concurrency = Math.max(1, Math.min(4, Number(process.env.PRESET_CONCURRENCY || 3)));

const genres = [
  ["romance", "言情", "雨后城市街角的双人远影与一把伞，关系暧昧，柔和电影光"],
  ["realistic-emotion", "现实情感", "普通家庭的安静餐桌与窗边旧物，生活质感，克制温暖"],
  ["suspense", "悬疑", "雨夜公寓走廊、半开的门与遗落手机，冷暖光对比，未知线索"],
  ["thriller", "惊悚", "空医院长廊与闪烁红色安全灯，远处模糊门影，压迫但不血腥"],
  ["science-fiction", "科幻", "未来城市天际线与近地轨道光环，人物剪影极小，理性宏大"],
  ["wuxia", "武侠", "山雨将至的古道、竹林与一柄入鞘长剑，东方水墨电影感"],
  ["political-intrigue", "权谋", "深宫长廊、层叠帷幕与棋盘残子，暗金冷青，克制肃杀"],
  ["fantasy", "玄幻奇幻", "云海中的巨型古门与发光符石，东方幻想，奇观但不杂乱"],
  ["folk-tales", "民间奇闻", "南方旧宅天井、纸灯笼与木门缝中的微光，民俗神秘感"],
  ["fan-fiction", "同人", "舞台后台般的多世界交汇空间，熟悉感与新想象并存，不出现任何受版权保护角色"],
  ["historical-romance", "演义", "旌旗远城与风沙古战场，史诗叙事，人物只作远景剪影"],
  ["high-concept", "脑洞", "日常房间被一道不合常理的发光裂隙分成两个世界，荒诞惊奇"],
  ["pure-love", "纯爱", "清晨窗帘、两只并放的杯子与柔和日光，纯净亲密，留白充足"],
  ["esports", "电竞", "空竞技场与发光电竞桌，赛前安静时刻，蓝紫霓虹但不过度炫目"],
  ["abo", "ABO", "现代精英公寓与玻璃幕墙，双人关系张力用距离和光影表达，不使用符号文字"],
  ["social-life", "世情", "老城巷口、早点铺蒸汽与来往人影，现实群像，烟火气与复杂人情"],
  ["marriage", "婚恋", "夜晚客厅里两把相对却空着的椅子，婚姻关系张力，成熟克制"],
];

const eras = [
  ["ancient", "古代", "古代庭院、月洞门、石阶与灯笼，服化道时代准确，无现代物件"],
  ["modern", "现代", "当代城市住宅与街景，真实生活细节，现代材质与自然光"],
  ["history", "历史", "具有真实历史质感的城墙、驿道与旧地图纹理，庄重可信"],
  ["future", "未来", "未来都市与干净的公共交通空间，可信科技细节，简洁而非赛博堆砌"],
  ["alternate-world", "架空", "不存在于现实王朝的山城宫阙与独特建筑体系，完整世界观"],
  ["apocalypse", "末日", "被自然重新覆盖的空城街道与远处避难灯光，荒凉但保留希望"],
  ["republic-era", "民国", "民国时期街巷、木格窗与旧式路灯，年代服饰只作远景，考据感"],
  ["period", "年代", "二十世纪旧居民院、搪瓷杯与木家具，胶片质感，具体生活年代感"],
];

const common = "竖版知乎短篇故事站外宣传卡底图。画面顶部与中部保留大面积、低细节、对比稳定的负空间，供后续叠加中文钩子；主体集中在下半部或边缘。电影感编辑插画，细节真实，高级克制，适合手机信息流。无任何文字、字母、数字、标志、水印、边框；无人物正脸；不血腥；不要海报排版。";
const items = [
  ...genres.map(([slug, label, scene]) => ({ id: `genre-${slug}`, dimension: "genre", label, scene })),
  ...eras.map(([slug, label, scene]) => ({ id: `era-${slug}`, dimension: "era", label, scene })),
];

await mkdir(outputDir, { recursive: true });

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function generate(item) {
  const file = resolve(outputDir, `${item.id}.jpg`);
  if (await exists(file)) return { ...item, file_name: `${item.id}.jpg`, status: "existing" };
  const prompt = `${common}\n预设维度：${item.dimension === "genre" ? "题材" : "时空"}；名称：${item.label}。\n场景：${item.scene}`;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${apiBase}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, size: "1024x1536", response_format: "b64_json", watermark: false }),
        signal: AbortSignal.timeout(600000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message || `HTTP ${response.status}`);
      const encoded = payload.data?.[0]?.b64_json;
      if (!encoded) throw new Error("response missing data[0].b64_json");
      await writeFile(file, Buffer.from(encoded, "base64"));
      process.stdout.write(`OK ${item.id}\n`);
      return { ...item, file_name: `${item.id}.jpg`, status: "generated", prompt };
    } catch (error) {
      lastError = error;
      process.stderr.write(`RETRY ${item.id} ${attempt}: ${error.message}\n`);
    }
  }
  return { ...item, file_name: null, status: "failed", error: lastError?.message || "unknown error" };
}

const queue = [...items];
const results = [];
async function worker() {
  while (queue.length) results.push(await generate(queue.shift()));
}
await Promise.all(Array.from({ length: concurrency }, worker));
results.sort((a, b) => items.findIndex(row => row.id === a.id) - items.findIndex(row => row.id === b.id));
const manifest = { generated_at: new Date().toISOString(), model, size: "1024x1536", watermark: false, count: results.length, succeeded: results.filter(row => row.status !== "failed").length, assets: results };
await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`DONE ${manifest.succeeded}/${manifest.count}\n`);
if (manifest.succeeded !== manifest.count) process.exitCode = 1;
