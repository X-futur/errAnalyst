# ErrAnalyst 第六阶段设计文档：记忆系统

> 基于 2026-08-14 grill-with-docs 会话产出。
> 决策见 [ADR-0010](./adr/0010-memory-system.md)，术语见 [CONTEXT.md](../CONTEXT.md)。

## 一、记忆模型

两层记忆，与现有"本地缓存"（错误分析缓存，不参与自动分析）严格区分：

- **短期记忆**：当前报错会话的进程内记忆，易失、不落盘。包含消息历史、对话上下文文件与滚动摘要。
  - 滚动摘要：消息被截断（超 20 条或 12000 字符）时，由 LLM 把被丢弃的消息压缩成摘要，存于 ChatSessionManager，作为"更早会话摘要"注入后续对话 prompt。摘要生成是惰性的、尽力而为（失败不影响对话），随会话结束清空。
- **长期记忆**：`~/.errAnalyst/memory.json`，全局用户级、持久。
  - 语义记忆：修复偏好（补丁代码）、修复建议偏好（文字指引）、错误分析偏好（分析结果）三类偏好陈述；
  - 统计记忆：常犯错误（errorType → 次数）；
  - 不存情景记忆：接受/拒绝等行为事件仅用于累加观察计数，事件本身不落盘。

## 二、长期记忆数据格式

```json
{
  "format": "memory-v1",
  "preferences": [
    {
      "id": "mem-<ts>-<seq>",
      "category": "fix | fixSuggestion | analysis",
      "statement": "倾向于最小改动，不做无关重构",
      "source": "implicit | explicit",
      "status": "active | candidate",
      "confidence": 0.6,
      "createdAt": 1720000000000,
      "lastUsedAt": 1720000000000,
      "hitCount": 3
    }
  ],
  "errorStats": {
    "AttributeError": 12,
    "FileNotFoundError": 5
  }
}
```

- category 枚举：`fix`（修复偏好）、`fixSuggestion`（修复建议偏好）、`analysis`（错误分析偏好）。
- source：`implicit`（行为推断，注入时标注"仅供参考"）、`explicit`（用户声明）。
- status：`active`（注入提示词）；`candidate`（仅 1 次观察的待确认项，不注入，只在 memory config 中展示，确认后转 active）。
- confidence：explicit = 1.0；implicit 初始 0.6，随观察次数上调，上限 0.9。
- 版本：`memory-v1`；读取时版本不匹配则清空重建（与 cache.json 的 `core-terms-v1` 策略一致）。

## 三、加载与注入

- 加载时机：每次构建 prompt 时读取一次 memory.json；`errAnalyst.memory.enabled` 为 false 时既不读取也不注入。
- 路由：

  | prompt | 注入内容 |
  |---|---|
  | 分析 prompt（`buildAnalysisPrompts`） | `analysis` + `fixSuggestion` 类偏好 + errorStats Top 5 |
  | 修复补丁 prompt（`buildFixPrompts` / `buildChatFixPrompts`） | `fix` 类偏好 |
  | 对话 prompt（`buildChatMessages`） | 三类偏好 + errorStats Top 5 |

- 对话补丁 prompt（`buildChatFixPrompts`）额外注入"## 更早会话摘要"（如存在），避免截断后的早期对话信息在补丁生成时丢失。
- 偏好注入：仅 status=active，全量注入，上限 30 条，超出按 lastUsedAt 降序截断；注入时更新 lastUsedAt。
- 常犯错误：errorStats 按次数降序取 Top 5，格式如 `AttributeError（12 次）`。
- 块格式（放用户消息的事实区，不进系统提示词）：

  ```text
  ## 用户记忆
  - [修复偏好·行为推断·置信 0.6·仅供参考] 倾向于最小改动，不做无关重构
  - [修复建议偏好·用户声明] 修复建议请分步骤并给出验证方法
  - 常犯错误：AttributeError（12 次）、FileNotFoundError（5 次）
  ```

- 无记忆内容时不注入该块。

## 四、隐式学习（修复偏好）

- 钩子：修复会话"结束修复"时，汇总各修改处的接受/拒绝结果。
- 每个被接受修改处的 reason（修改原因）作为候选观察；同一性按归一化文本判定（小写、去空白与全半角标点、移除停用词如"添加/增加/需要"）。
- 规则：
  - 归一化后相同且累计接受 ≥2 次 → 自动写入 active 条目（source=implicit，confidence 随次数上调）；
  - 累计 1 次 → candidate 条目（不注入，待用户在 memory config 确认）；
  - 拒绝不产生任何条目（拒绝可能意味着修复本身错误，而非风格异议）。
- 写入时机：结束修复时一次性落盘；隐式学习不打断确认流程。
- 显式声明：用户在 memory config 中新增条目（选类别 + 输入 statement），source=explicit、status=active，立即生效。

## 五、常犯错误统计

- 每次报错分析成功（autoAnalyze 返回有效结果）时，`errorStats[errorType] += 1`，立即落盘。
- 独立于 200 条错误缓存（缓存会淘汰，统计不丢）。

## 六、管理命令 memory config

- CLI（`bin/erranalyst`）：`CLI_HANDLERS` 新增 `'memory config'`，readline 交互菜单（沿用 `provider set` 模式）：
  1. 列出全部条目（类别 / 内容 / 来源 / 置信度 / 状态），candidate 标注"待确认"；
  2. 新增（显式声明）：选类别 → 输入偏好内容；
  3. 编辑 / 删除 / 清空；
  4. 候选确认：candidate → active；
  5. 开关 `errAnalyst.memory.enabled`（读写 settings.json，与 `config show` 一致）。
- VS Code 侧：configManager 新增 `memoryConfig()`，QuickPick / InputBox 同款流程；commands.json 注册 `{ vscodeId: 'errAnalyst.memoryConfig', title: 'erranalyst memory config', cli: 'memory config', availability: 'both' }`，经 `sync-commands.js` 同步 package.json。
- CLI 与扩展共享 `src/shared/memory-store.js`（仿 err-store 的 read/write/clear），不复制读写逻辑。

## 七、实现位置

- `src/shared/memory-store.js` / `memory-store.d.ts` — `~/.errAnalyst/memory.json` 读写（仿 err-store）
- `src/storage/userMemory.ts` — UserMemory：加载、增删改查、候选确认、隐式学习入账、errorStats 计数、按类别路由的注入载荷
- `src/chat/session.ts` — 滚动摘要：summary 字段 + trim 截断时返回"需要摘要"标记
- `src/chat/prompt.ts` — 对话 prompt 注入 "## 用户记忆" 与 "## 更早会话摘要"
- `src/llmProvider/openaiCompatible.ts` — `buildAnalysisPrompts` 注入
- `src/fix/prompt.ts` — `buildFixPrompts` / `buildChatFixPrompts` 注入
- `src/fix/session.ts` — 结束修复时暴露接受/拒绝观察（reason 归一化）
- `src/extension.ts` — 初始化 UserMemory、接线隐式学习与统计、注册 `errAnalyst.memoryConfig`、编排摘要生成
- `src/config.ts` — 新增 memoryEnabled getter
- `src/configManager.ts` — `memoryConfig()` VS Code 交互
- `bin/erranalyst` — `'memory config'` CLI 处理
- `commands.json` — 命令登记

## 八、实现顺序

1. memory-store + UserMemory 存储层（格式、版本、读写）
2. 三处 prompt 注入（路由、块格式、enabled 开关）
3. 隐式学习（fix session 钩子、归一化判重、candidate 状态）
4. memory config（CLI → VS Code 侧 + commands.json）
5. 测试与收尾：归一化判重单测、注入格式与空记忆不注入、阈值与 candidate 流转、CLI 冒烟
