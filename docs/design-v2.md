# ErrAnalyst 第二阶段设计文档：一键修复（逐处确认）

> 基于 2026-08-01 思维梳理会话产出。
> 与 [design-v1.md](./design-v1.md) 的关系：保留第一阶段完整分析链路，将“不做自动修复”改为“一键修复（逐处确认）”，正式翻案见 [ADR-0001](./adr/0001-one-click-fix-with-confirmation.md)。

## 一、目标与非目标

**目标**：用户点击修复建议卡片右下角的“一键修复”按钮后，AI 基于已有报错信息和代码上下文生成结构化修改补丁；插件在编辑器中用绿/红展示每一处修改，用户逐处确认（也可“全部接受”）后才写入本地文件，并反馈一共修复了几处。

**非目标**：不自动重跑终端命令；不自动重新 AI 分析；不无确认写文件；不缓存补丁；不依赖 Continue 扩展。

## 二、触发与数据流

```
用户点击“一键修复”（修复建议卡片右下角）
  │
  ▼
extension 校验：开关已开启、存在可用 LLM Provider
  │
  ▼
构建修复 Prompt：原始 traceback + Parsed Error Data + Source Context + 当前文字分析
  │
  ▼
LLM 返回结构化修复补丁 JSON（≤20 处，仅允许修改 Source Context 内文件）
  │
  ▼
展示前校验：每个 hunk 的 oldLines 与当前编辑器缓冲匹配
  │
  ▼
渲染：编辑器绿/红装饰 + CodeLens“接受/拒绝”；侧边栏显示共 N 处、全部接受/全部拒绝
  │
  ▼
用户逐处确认：接受时再次校验 → WorkspaceEdit 写入 → 更新计数
  │
  ▼
应用完成：侧边栏提示“已应用 X 处，代码已更新，可重新运行验证”
```

## 三、修复补丁数据契约

```json
{
  "changes": [
    {
      "file": "src/service.py",
      "reason": "对可能为空的返回值增加 None 检查",
      "oldLines": ["result = query_db(user_id)"],
      "newLines": [
        "result = query_db(user_id)",
        "if result is None:",
        "    result = {}"
      ]
    }
  ]
}
```

规则：

- 一个 `changes[]` 元素就是一个“修改处”，可单独接受或拒绝，计数即数组长度。
- `newLines` 为空表示删除；`oldLines` 必须非空，作为定位锚点/被替换行；新增代码时把插入位置前的一行同时放入 `oldLines` 和 `newLines`。
- 所有 `file` 必须是本次已发送给 LLM 的 Source Context 文件（主报错文件、调用栈文件、配置文件、同级文件）。
- 解析失败、字段缺失或文件不在白名单内时，该处标记为无效并跳过。

## 四、UI 与交互

| 元素 | 行为 |
|---|---|
| “一键修复”按钮 | 修复建议卡片右下角；生成中显示加载态；无 Provider 或开关关闭时隐藏/禁用 |
| 编辑器装饰 | 新增/修改行绿色底色；删除行红色底色 + 删除线 |
| CodeLens | 每个修改处上方显示“接受 / 拒绝” |
| 侧边栏汇总 | “共 N 处 · 已接受 X”；“全部接受 / 全部拒绝 / 撤销全部” |
| 跳转 | 点击侧边栏某一处定位到编辑器对应 hunk；生成后默认打开主报错文件，其他文件靠跳转打开 |

## 五、校验与安全

- **双重校验**：展示前校验一次，接受时再校验一次；始终以当前编辑器缓冲为准，未保存修改也按缓冲处理。
- **失效处理**：校验不通过（文件被改动、行漂移）的 hunk 标记为“已失效”，不写入、不静默跳过计数。
- **最小修改原则**：Prompt 明确只修与本次报错直接相关的代码，禁止无关重构、格式化、注释改动。
- **数量上限**：单次最多 20 处，超出截断并提示用户。
- **落盘方式**：使用 `WorkspaceEdit`，支持编辑器 Undo；不直接 `fs.writeFileSync` 覆盖。

## 六、修复会话生命周期

- 状态：`生成中 → 待确认 → 已接受 / 已拒绝 / 已失效`。
- 接受后立即写入并保留“撤销全部”，直到会话结束。
- 会话结束条件：遇到新报错、点击“重新 AI 分析”、用户主动“结束修复”。
- 结束时清除所有编辑器装饰、CodeLens 和撤销入口。

## 七、配置与缓存

- 新增配置 `errAnalyst.enableOneClickFix`，默认 `true`。
- 本地缓存只作历史记录：自动分析不查询缓存，每次分析都调用 AI 并写入历史；只缓存文字分析（translation、keywords、analysis、fixSuggestion），不缓存修复补丁。
- 从缓存查阅的旧错误同样可点击“一键修复”，此时使用当前文件内容现场生成补丁。

## 八、建议文件结构

```
src/fix/
├── types.ts        ← FixHunk、FixSession、会话状态类型
├── prompt.ts       ← 修复 Prompt 构建 + 响应解析
├── session.ts      ← 修复会话管理（创建、结束、计数）
├── validator.ts    ← oldLines 与当前缓冲匹配校验
├── applier.ts      ← WorkspaceEdit 应用与“撤销全部”
└── decoration.ts   ← 绿/红装饰 + CodeLens 注册
```

`src/ui/analysisWebview.ts` 增加 `startFix / acceptFixHunk / rejectFixHunk / acceptAllFix / rejectAllFix / undoAllFix / endFix` 消息；`src/extension.ts` 负责组装 `FixSessionManager` 与现有 `ContextBuilder`、LLM Provider。

## 九、实现顺序

1. `types.ts` + `prompt.ts`（含 JSON 解析，单测覆盖格式错误、超上限、越权文件）
2. `validator.ts` + `applier.ts`（单测覆盖精确匹配、行漂移、未保存缓冲、多 hunk 顺序）
3. `decoration.ts`（装饰 + CodeLens 命令）
4. Webview 按钮与汇总交互
5. 会话生命周期与“撤销全部”
6. 配置开关与文档收尾
