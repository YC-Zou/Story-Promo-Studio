# 知乎故事 AI 宣发工作台

**Zhihu Story Promo Studio**

将知乎故事转化为传播文案、连续漫画、单图故事卡与可选配乐，并导出完整站外宣传素材包的 AI 工作台。

An AI-powered studio that turns Zhihu stories into compelling hooks, comic sequences, promo cards, and BGM—ready to export as a complete off-platform promotion kit.

## 一键启动

### Windows

1. 安装 64 位 [Node.js 20+](https://nodejs.org/) 和 [Python 3.10–3.13](https://www.python.org/downloads/)，安装 Python 时勾选 **Add python.exe to PATH**。
2. 直接双击 `启动.cmd` 可进入**演示模式**，使用固定授权样例和固定输出，不需要 API Key，也不会安装配乐模型。
3. 如需真实生成，先双击 `首次配置 API Key.cmd` 保存模型服务配置，再双击 `启动.cmd`。
4. 使用结束后，双击 `停止.cmd`。

真实生成模式首次启用配乐时会自动创建 Python 虚拟环境、安装依赖，并从 Hugging Face 下载 Stable Audio 3 Small Music 模型，约需 2.5 GB；后续启动会直接复用。模型权重、虚拟环境、运行状态、生成文件和 API Key 均不会提交到 GitHub。

> 配乐默认关闭。即使没有启动本地配乐服务，传播文案、图片和宣传素材包仍可正常生成。

## 运行模式

- `演示模式`：无 Key 时默认启用，只接受内置授权样例，使用固定、可回归的审核输出，不调用外部付费服务。
- `真实生成模式`：检测到 API Key 后启用，调用实际文字与图片服务；失败时不会退回伪造结果。
- `测试模式`：仅由 `npm test` 启动的隔离服务使用，故障模拟参数在其他模式会被拒绝。

可通过 `APP_MODE=demo|live|test` 显式选择模式。`test` 只应用于自动化测试。

## 数据与隐私

- 正文会发送给已配置的 AI 服务；请勿提交未授权作品或含个人隐私的内容。
- 浏览器持久化状态不包含完整正文和完整模型响应，只保存恢复流程所需的作品 ID、进度、确认结果和用户明确保存的单图草稿。
- 服务端正文与生成文件默认保存 24 小时，启动时及每小时自动清理；可用 `DATA_RETENTION_HOURS` 调整。
- 输入页可执行“删除作品及生成记录”，删除正文、分析、图片、配乐、ZIP 和浏览器状态。
- `data/samples.jsonl` 中每份演示故事均带有机器可读的作者、来源、允许用途、公开演示、再分发及到期字段；发布前仍应由仓库所有者复核授权凭据。

不需要 BGM 时，可右键 `start.ps1` 选择“使用 PowerShell 运行”。

### macOS

1. 安装 [Node.js 20+](https://nodejs.org/)；Stable Audio 所需的 Python 3.11 会由项目安装器自动管理，无需替换系统 Python。
2. 双击 `首次配置 API Key.command`，按提示保存模型服务配置。
3. 双击 `启动.command`。脚本会启动 Stable Audio 和应用，并自动打开 <http://127.0.0.1:4173>。
4. 使用结束后，双击 `停止.command`。

macOS 首次打开脚本若被 Gatekeeper 阻止，请在 Finder 中右键该文件并选择“打开”。也可以在终端运行：

```bash
npm run configure:mac
npm run start:mac
```

不需要 BGM 时运行 `npm run start:mac:no-bgm`。应用的文字、图片和素材包功能不受影响。

首次完整启动会创建本地 Python 虚拟环境、安装依赖，并从 Hugging Face 下载 Stable Audio 3 Small Music 模型，模型本身约 2.5 GB，建议至少预留 5 GB 磁盘空间；空间不足时启动器会跳过 BGM 并继续打开主应用。后续启动会直接复用。

## 模型服务配置

默认配置面向项目开发时使用的 OpenAI 兼容网关：

- `OPENAI_API_KEY` / `OPENAI_NEXT_API_KEY`
- `OPENAI_BASE_URL=https://api.openai-next.com/v1`
- `HOOK_MODEL=gpt-5.6-sol`
- `SEEDREAM_MODEL=doubao-seedream-5-0-pro-260628`

如使用其他 OpenAI 兼容服务，请在首次配置时填写对应 Base URL 和模型名。服务必须提供兼容的流式 Chat Completions 与 `POST /images/generations` 接口。

- Windows：密钥保存在当前 Windows 用户的环境变量中。
- macOS：密钥保存在 `~/Library/Application Support/StoryPromoStudio/config.env`，文件权限为当前用户可读写（`600`）。

两种方式都不会把密钥写入仓库。若密钥曾粘贴到聊天、截图或公开位置，建议在服务商后台撤销并重新生成。

### 证书错误排查

若日志出现 `unable to get local issuer certificate` 或 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，说明 HTTPS 连接在到达模型服务前就被本机网络代理或安全软件拦截，并非 Key 或请求格式错误。请切换到可信网络，或让网络管理员提供并安装组织 CA；不要使用 `curl -k` 或关闭 Node.js TLS 校验，因为这会让 API Key 和故事正文失去传输保护。

macOS 启动器还会检查“默认网络失败、`en0` 直连成功”的情况。若命中，它会为本项目启动仅监听本机的安全转发服务，让模型请求绕开全局 VPN，同时继续验证上游 HTTPS 证书；不会关闭 VPN，也不会影响其他应用的网络路由。

## 主要能力

- 五步流程：导入故事、确定文案、选择形式、生成与复核、导出素材。
- 一次 API 调用从完整短篇同时生成 3 条结构化传播文案，不追加模型质检调用。
- 对作者编辑或自定义的传播文案重新做事实与剧透检查。
- 从 5 种参考画风中选择并生成 2–8 页连续漫画。
- 基于完整的 17 种题材、8 种时空共 25 张预设底图制作单图故事卡，相关项优先排列。
- 付费生成前展示页数、情节节拍、背景、预计等待时间与可选配乐预案。
- 使用内置 Stable Audio 3 TFLite 服务在本机 CPU 上生成可选配乐，默认关闭。
- 异步处理图片与配乐，支持取消、刷新恢复、退避轮询和失败部分重试。
- 连续漫画支持单页问题反馈、仅重生成该页、查看并恢复上一版；单图故事卡可返回编辑器更换背景或重新排版。
- 单独下载每页漫画或单图故事卡，并在浏览器中把图片与 BGM 合成为可预览、下载的 WebM 视频。
- 选择单图背景后进入轻量故事卡编辑器，在浮窗短句、悬念便签、线索时间轴、电影字幕、章节纸页和强冲击标题之间切换；编辑过程不会自动保存。
- 服务端流式导出最终 PNG、传播文案、发布说明、最小化 manifest 及可选配乐，不包含正文、Prompt、模型参数、项目 ID、任务 ID或错误日志。
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

```bash
node --check server.mjs
node --check app.js
npm test
```

`npm test` 会自动启动隔离测试服务，使用固定夹具完成语法、接口、资源、故障、取消、清理和删除检查，不需要 API Key 或外部模型。应用本身没有 npm 运行时依赖。执行 `npm start` 可只启动 Node.js 应用服务。

如需针对已启动且配置了真实模型服务的实例执行外部冒烟测试，运行 `npm run test:external`。`npm start` 不会自动读取 macOS 私有配置文件，也不会启动 BGM，因此日常体验建议使用上方的平台启动入口。

## 第三方组件

`third_party/stable-audio-3-tflite/` 与 `third_party/fabric/` 分别包含 Stable Audio 3 源码和 Fabric.js 画布库，并保留各自的 MIT License。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Stable Audio 模型权重需在首次运行时另行下载，并受其来源页面所列许可条款约束。

本仓库的应用代码尚未声明开源许可证；公开发布前请由仓库所有者选择并添加合适的 `LICENSE`。
