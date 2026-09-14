# 精华聊天记录附加任务 v1

此任务附加在原有三候选钩子任务之后，同一次模型调用完成。不得修改、替代、重排或减少原任务要求的 `hook_type_scores`、`candidate_plan`、`candidates`、`best_candidate_id` 与 `best_hook`；`candidate_plan` 和 `candidates` 仍然各有且只有三项。

在原 JSON 根对象中额外加入一个 `highlight_dialogue`。它不是第四条钩子，不参加钩子评分、候选排序或最佳钩子选择。

## 一、选择最值得传播的连续对话

扫描完整正文，先在内部建立 3—6 个候选对话片段。片段必须来自同一时间、地点、聊天窗口或持续冲突，严禁拼接不同章节、不同场景的台词。

内部比较以下维度，但不要输出评分过程：

1. relationship_density：几句话内能否看懂人物关系、立场或权力差；
2. turning_point：是否包含身份反差、误会升级、危险逼近、情绪翻转或关键选择；
3. dialogue_naturalness：原台词是否自然，是否适合消息逐条出现；
4. cold_reader_clarity：未读原作的人能否快速理解谁在跟谁说什么；
5. visual_rhythm：长短句是否有变化，是否形成清楚的出现节奏；
6. spoiler_control：是否停在最想继续阅读的位置且不揭示最终答案或结局。

选择综合表现最强的一段，不得机械选择对白最多、最靠前或与最佳钩子相同的段落。理想结构是“建立关系或情境 → 冲突升级 → 反差/危险/误会出现 → 停在悬念或情绪峰值”。

## 二、聊天类型、标题与人物

- 原文明示多人聊天群时，`chat_type` 为 `group`；普通对话或私聊为 `direct`。
- `chat_title` 使用原文中的群名、群聊称呼或对方姓名。正文没有正式群名时使用“朋友群聊”等中性称呼，禁止臆造。
- direct 使用 2 位参与者；group 使用实际发言的 2—6 位参与者。
- `display_name` 必须保留当前场景中原文使用的姓名、群昵称或备注，包括空格和英文后缀。群昵称不得擅自换成本名，不同昵称不得合并成“对方”。
- `is_self` 仅在明确属于第一人称叙述者时为 true。
- 连续引号共享同一个说话引导语时，必须继承同一说话人，直到正文明确切换人物。

## 三、消息与状态描述

- 输出 5—10 个时间顺序项目，并停在关键答案或结局揭晓之前。
- 人物发言使用 `text`，不包含说话人前缀，优先逐字引用原作。
- 不显示就会误解下一句的关键动作、身体状态或内心 OS 使用 `overlay`；`speaker_id` 必须为 null，通常 0—2 条。
- overlay 居中显示，不能伪装成人物消息，不能代替普通旁白，也不能给网络聊天凭空添加现场动作。
- 每项 2—42 个非空白字符。只允许为连贯性做轻微删减、代词补全或把有依据的叙述压缩成一句即时反应；改写时 `adaptation` 为 `lightly_adapted`，原句为 `verbatim`。
- 每项必须带至少一个存在于原任务 `content_analysis.evidence_pool` 的 `source_refs`，证据必须支持该项的具体台词、动作或事实。
- `sticker_hint` 只是可选情绪关键词，没有必要时为空字符串，不强制使用表情包。

## 四、视频时长

`target_duration_seconds` 先按消息数量、每项字数和 overlay 数量合理估算，范围 10—25 秒。服务端会重新计算。不得为了凑固定时长删减关键信息。

## 五、附加输出结构

在原任务要求的 JSON 根对象中增加：

```json
"highlight_dialogue": {
  "title": "精华对话",
  "chat_type": "direct",
  "chat_title": "原文中的对方姓名或群名",
  "scene_summary": "不剧透地概括同一连续场景",
  "participants": [
    { "id": "p1", "display_name": "原文姓名或群昵称", "side": "left", "is_self": false },
    { "id": "p2", "display_name": "我", "side": "right", "is_self": true }
  ],
  "messages": [
    {
      "message_id": "M1",
      "speaker_id": "p1",
      "type": "text",
      "text": "来自正文的精华台词",
      "source_refs": ["E2"],
      "adaptation": "verbatim",
      "sticker_hint": ""
    },
    {
      "message_id": "M2",
      "speaker_id": null,
      "type": "overlay",
      "text": "有原文依据的动作或内心 OS",
      "source_refs": ["E3"],
      "adaptation": "lightly_adapted",
      "sticker_hint": ""
    }
  ],
  "source_refs": ["E2", "E3"],
  "spoiler_risk": "low",
  "target_duration_seconds": 18
}
```

只返回合并后的一个合法 JSON 对象，不要输出第二个 JSON、Markdown 说明或评分过程。
