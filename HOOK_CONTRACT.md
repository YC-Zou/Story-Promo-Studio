# 服务端接口契约

所有响应均为 UTF-8 JSON（音频与静态文件除外）。错误结构：

```json
{ "error": "可读错误信息", "details": [] }
```

## 健康与授权样例

- `GET /api/health`：返回文本、图片、BGM 适配器状态及正文上限。
- `GET /api/samples`：只返回样例元数据，不返回官方钩子。
- `GET /api/samples/:work_id`：返回标题、标签和正文；`gold_hook` 永不进入前端或生成请求。

## 分析与三候选

`POST /api/projects/analyze`

```json
{
  "title": "作品名",
  "author": "作者",
  "source_url": "https://www.zhihu.com/...",
  "authorized": true,
  "labels": ["惊悚"],
  "body": "完整正文"
}
```

正文按移除空格、换行、制表符后的字符数计算，超过 50,000 返回 413。正常模型模式只调用一次文本模型，响应同时包含：

- `story_profile`
- `content_analysis`
- 固定 5 项 `hook_type_scores`
- 恰好 3 项 `candidate_plan`
- 恰好 3 项 `candidates`
- `best_candidate_id` 与按结构化行重算的 `best_hook`

服务端会检查枚举、数量、三个类型/策略互异、计划一致性、行长、证据引用并重算选择分与候选排名分。分析接口不再追加模型质检或自动重写调用：一次请求未返回合格结构时直接报错，由用户决定是否重新分析。未配置密钥时返回 503，不生成或返回模拟候选。

`POST /api/projects/:id/hooks/regenerate-one` 输入 `{ "candidate_id": "C2" }`，只替换对应计划的一个候选并保留冻结分析。`GET /api/projects/:id/hooks/selected/export` 只在钩子已确认后返回与 `final_text` 完全一致的 `text/plain`，不调用模型。

## 确认钩子

`POST /api/projects/:id/select-hook`

```json
{ "candidate_id": "C1", "final_text": "作者最终确认的文本" }
```

接口会重新生成 `selected_lines` 并检查 20—300 个非空白字符。未修改的生成候选直接确认；作者编辑或自定义文本时才会调用模型做事实与剧透校验。随后返回 `selected_hook_profile` 和基于钩子类型、对白及叙事节点计算的 `material_recommendation`。校验失败返回 422，并在 `details` 中给出问题句、代码和原因。

## 底图、生成与任务

- `GET /api/backgrounds?category=horror_rules`：返回完整 25 个不可编辑的 `BackgroundPreset`（17 种题材、8 种时空），分析相关项优先。
- `POST /api/projects/:id/generate`：输入 `selected_type=comic|card`；comic 必须带五种之一的 `comic_style`，card 必须带合法 `background_id`。接口先立即创建任务，视觉与音乐提示词随后在后台准备。
- `GET /api/tasks/:id`：读取 `queued / running / succeeded / partially_failed / failed` 以及 material/music 子任务。
- `POST /api/tasks/:id/retry`：只重试失败子任务并沿用冻结输入。
- `GET/HEAD /api/tasks/:id/audio`：代理成功的本机音频，支持 byte range，不暴露本机文件路径。
- `GET /api/tasks/:id/images/:index`：代理 Seedream 成功底图，不向前端暴露上游地址或密钥。
- `GET /api/projects/:id/export?task_id=:taskId`：校验知乎原作链接、任务归属及已完成视觉物料，返回需省略的失败资源。
- `POST /api/tasks/:id/package`：接收浏览器合成的 ZIP，校验本地文件头与中央目录结尾后落盘。
- `GET/HEAD /api/tasks/:id/package`：下载或检查已经准备的真实发布包。

浏览器用服务端返回的冻结计划生成预览，在导出前按指定 `task_id` 校验归属，再生成 PNG 与无压缩 ZIP并交给服务端提供真实下载。宣传图把全部 `selected_lines` 按原顺序合并为 2—6 组，不增删改字；漫画按原顺序分配至 2—8 页。每张图片可单独下载；视觉与音频均成功时，浏览器可实时合成带 BGM 的 WebM 视频。`project.json` 保存事实引用、确认钩子、类型、任务和适配器模式，不保存密钥。

## 前端集成

```js
window.NovelPromoWorkbench.getState();
window.NovelPromoWorkbench.simulateNextFailure("music");
window.NovelPromoWorkbench.reset();
```

`simulateNextFailure` 仅用于验收失败/重试路径，不在用户界面中显示。
