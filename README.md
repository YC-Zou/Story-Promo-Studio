# 知乎故事 AI 宣发工作台

**Zhihu Story Promo Studio**

将知乎故事转化为传播钩子、连续漫画、宣传卡与 BGM，并一键导出完整站外宣发素材包的 AI 工作台。

An AI-powered studio that turns Zhihu stories into compelling hooks, comic sequences, promo cards, and BGM—ready to export as a complete off-platform promotion kit.

## 一键启动（Windows）

1. 安装 64 位 [Node.js 20+](https://nodejs.org/) 和 [Python 3.10–3.13](https://www.python.org/downloads/)，安装 Python 时勾选 **Add python.exe to PATH**。
2. 双击 `首次配置 API Key.cmd`，按提示保存模型服务配置。
3. 双击 `启动.cmd`。脚本会启动 Stable Audio 和应用，并自动打开 <http://127.0.0.1:4173>。
4. 使用结束后，双击 `停止.cmd`。

首次启动会自动创建 Python 虚拟环境、安装依赖，并从 Hugging Face 下载 Stable Audio 3 Small Music 模型，约需 2.5 GB；后续启动会直接复用。模型权重、虚拟环境、运行状态、生成文件和 API Key 均不会提交到 GitHub。

> 不需要 BGM 时，也可以只运行 `start.ps1`。应用会正常生成文字和图片物料，BGM 任务会显示失败但不会阻止图片包导出。

## 模型服务配置

默认配置面向项目开发时使用的 OpenAI 兼容网关：

- `OPENAI_API_KEY` / `OPENAI_NEXT_API_KEY`
- `OPENAI_BASE_URL=https://api.openai-next.com/v1`
- `HOOK_MODEL=gpt-5.6-sol`
- `SEEDREAM_MODEL=doubao-seedream-5-0-pro-260628`

如使用其他 OpenAI 兼容服务，请在首次配置时填写对应 Base URL 和模型名。服务必须提供兼容的流式 Chat Completions 与 `POST /images/generations` 接口。密钥仅保存在当前 Windows 用户的环境变量中，不会写入仓库。

## 主要能力

- 一次 API 调用从完整短篇同时生成 3 条结构化传播钩子，不追加模型质检调用。
- 对作者编辑或自定义的钩子重新做事实与剧透校验。
- 从 5 种参考画风中选择并生成 2–8 页连续漫画。
- 基于完整的 17 种题材、8 种时空共 25 张预设底图制作单图宣传卡，相关项优先排列。
- 使用内置 Stable Audio 3 TFLite 服务在本机 CPU 上生成 BGM。
- 并行处理图片与音乐，失败子任务可重试。
- 单独下载每页漫画或宣传图，并在浏览器中把图片与 BGM 合成为可预览、下载的 WebM 视频。
- 选择单图底图后进入轻量宣传图样式编辑器，在浮窗短句、悬念便签、线索时间轴、电影字幕、章节纸页和强冲击标题之间切换；支持无标点分句、调画面气质、换底图和拖动微调。编辑过程不会自动保存，保存定稿后点击返回会直接进入生成进度，定稿会用于结果、视频与发布包。
- 导出包含视觉物料、发布文案及可选 BGM 的 ZIP 发布包。
- 支持刷新和服务重启后的任务状态恢复。

## 项目结构

```text
assets/                              预设底图与展示素材
docs/product/prompts/                正式模型提示词
scripts/                             启动脚本与素材维护工具
tests/                               静态与 API 回归测试
third_party/stable-audio-3-tflite/   Stable Audio 3 CPU/TFLite 源码
third_party/fabric/                   海报画布编辑器（Fabric.js）
app.js                               浏览器端应用
poster-editor.html/.css/.js          轻量宣传图样式编辑器
server.mjs                           Node.js 服务端
index.html / styles.css              页面与样式
```

运行数据会自动写入 `work/runtime/`，Stable Audio 的模型和缓存写入其本地目录；它们都已加入 `.gitignore`。

## 开发与验证

```powershell
node --check server.mjs
node --check app.js
node tests/smoke.mjs
```

应用本身没有 npm 运行时依赖。执行 `npm start` 可只启动 Node.js 应用服务。

## 第三方组件

`third_party/stable-audio-3-tflite/` 与 `third_party/fabric/` 分别包含 Stable Audio 3 源码和 Fabric.js 画布库，并保留各自的 MIT License。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Stable Audio 模型权重需在首次运行时另行下载，并受其来源页面所列许可条款约束。

本仓库的应用代码尚未声明开源许可证；公开发布前请由仓库所有者选择并添加合适的 `LICENSE`。
