 # ErrAnalyst 第一阶段设计文档
 
 > 本文档记录了 ErrAnalyst 重构至第一阶段的完整决策，涵盖产品定位、数据流、模块职责、UI 布局和文件结构。
 > 基于 2026-07-25 的思维梳理会话产出。
 
 ## 一、产品定位
 
 - **Python first**：第一阶段专注 Python 报错分析，后续扩展为全语言通用工具
 - **第一阶段目标**：帮用户看懂报错 + 精准定位到出错代码 + 给出修改建议（文字）
 - **不做自动修复**：`FixProvider`、`fixCode`、`actions[]` 全部移除，第一阶段不修改用户源代码
 
 ## 二、数据流
 
 ```
 VSCode 终端执行结束
   │
   ▼
 TerminalWatcher
   │  主触发: exitCode !== 0
   │  补充触发: exitCode === 0 且含 Traceback 且 parse() 返回非 null
   │  (3s 防抖)
   ▼
 ErrorParser.parse()
   │  纯 Python traceback 结构化解析，不依赖外部文件或网络
   ▼
 ParsedTraceback
   ├─ primary: { errorType, errorMessage, filePath, lineNumber, stackFrames, caretLines? }
   ├─ chain[]: 链式异常（和 primary 同结构），不包括 fullTraceback
   │   └─ relationship: 'cause' | 'context' | 'implicit'
   └─ fullTraceback: 原始文本
   │
   ▼ (并发)
   ├─ categoryClassifier
   │    └─ 基于 error-categories.yaml 映射 errorType → 类别
   │    └─ 未命中则 fallback 到 AI 判断（AI 返回 JSON 中带 category 字段）
   │
   └─ contextBuilder
        └─ 统一优先级积分方案，贪婪消费 ~7000 字符预算
        └─ 候选来源: primary 栈帧 / chain 栈帧 / 配置文件 / 同级文件
   │
   ▼
 AI (DeepSeek / Kimi / Qwen) — Prompt 三部分:
   │  Part 1: 结构化报错数据（errorType、chain 摘要）
   │  Part 2: 相关源代码（按优先级积分排序）
   │  Part 3: 分析指令（约束 JSON 输出格式）
   ▼
 AI 返回 JSON:
   ├─ translation (中文翻译，{{keyword}} 标记术语)
   ├─ keywords [{cn, en}] (中英对照术语)
   ├─ analysis (根因分析，含可点击 file:line 引用)
   ├─ fixSuggestion (文字修复建议，无代码)
   └─ category (仅当规则文件未命中时出现)
   │
   ▼
 ErrorMemory (缓存 → ~/.errAnalyst/cache.json)
   │  去掉 fixCode 相关字段
   │  保留精确匹配 + Levenshtein 模糊匹配
   │  保留错误历史列表展示
   ▼
 Webview UI (从上到下)
 ```
 
 ## 三、`parse()` 输出结构
 
 ```typescript
 interface ParsedTraceback {
   // 主异常（最外层，界面默认展示）
   errorType: string;
   errorMessage: string;
   filePath: string;
   lineNumber: number;
   stackFrames: StackFrame[];
   fullTraceback: string;
   caretLines?: number[];
 
   // 链式异常（因果链，从根因到外层，不包含最外层）
   chain: ChainEntry[];
 }
 
 interface ChainEntry {
   errorType: string;
   errorMessage: string;
   filePath: string;
   lineNumber: number;
   stackFrames: StackFrame[];
   relationship: 'cause' | 'context' | 'implicit';
   caretLines?: number[];
 }
 
 interface StackFrame {
   file: string;
   line: number;
   function: string;
   codeLine?: string;
 }
 ```
 
 ### 链式异常的存储规则
 
 - `chain[]` 数量 = 链式异常层数 - 1（最外层作为 primary 在外）
 - `chain[0]` 为根因（最内层），最后一个为最外层的前一层
 - 排序方向：因果顺序，从内到外
 
 ### `identify()` 的处理
 
 - 第一阶段移除所有关键词匹配逻辑
 - 保留空壳接口的位置，未来全语言时按语言扩展
 - 类别推导交给 `categoryClassifier`（规则文件 + AI fallback）
 
 ## 四、类别推导规则（`error-categories.yaml`）
 
 ```yaml
 compilation:
   - pattern: "SyntaxError|IndentationError|TabError"
 
 dependency:
   - pattern: "ModuleNotFoundError|ImportError"
 
 system:
   - pattern: "PermissionError|FileNotFoundError|ConnectionRefusedError|ConnectionError"
   - pattern: "EOFError|MemoryError|BrokenPipeError"
   - pattern: "OSError"
 
 fallback: ai
 ```
 
 规则文件放在 VS Code 扩展安装目录内，开箱即用。用户可通过 VS Code 设置指定自定义路径覆盖。
 
 ## 五、`contextBuilder` 统一优先级积分方案
 
 | 候选来源 | 优先级分 | 读取范围 |
 |---|---|---|
 | primary 栈帧最后一帧（最终出错处） | 100 | ±60 行 |
 | chain 根因（chain[0]）各栈帧 | 90 | ±40 行 |
 | primary 栈帧其他帧 | 80 | ±30 行 |
 | chain 中间层各栈帧 | 60 | ±20 行 |
 | 配置文件（package.json 等） | 40 | 完整文件，限 30 行 |
 | 报错文件同目录同级文件 | 20 | 前 20 行 |
 
 - 总预算：~7000 字符
 - 按优先级分从高到低排序，贪婪消费预算
 - 分数和预算可通过配置调整
 
 ## 六、UI 布局（从上到下）
 
 | 元素 | 策略 |
 |---|---|
 | 错误类型标题（`⚠️ ZeroDivisionError`） | 始终显示 |
 | 类别标签（`[▶ 运行时错误]`） | 基于类别显示 |
 | 源代码上下文 | AI analysis 引用到的文件行默认展开，其余折叠 |
 | 调用栈 | 默认折叠 |
 | 中文翻译 | 卡片，`{{keyword}}` 渲染为高亮标记 |
 | 关键词 pill | 中英对照，hover/keyword 触发编辑器跳转 |
 | 错误分析 | 卡片，文件:行号为可点击链接，跳转到编辑器对应位置 |
 | 修复建议 | 纯文本卡片 |
 | 终端输出 | 最底下，默认折叠 |
 
 ## 七、触发策略
 
 | 条件 | 行为 |
 |---|---|
 | `exitCode !== 0` | 主触发，走完整 parse 流程 |
 | `exitCode === 0` 且 `extractErrorBlock()` 非 null 且 `parse()` 成功 | 补充触发 |
 | 其余情况 | 忽略 |
 
 - 防抖：3 秒，基于 `category + firstErrorLine` 去重
 - 缓冲区上限：100KB
 
 ## 八、AI Prompt 结构
 
 ### Part 1：结构化报错数据
 
 ```
 ## Error Details
 
 Type: ZeroDivisionError
 Message: division by zero
 Error chain:
   [cause]  db.py:10 → cursor.fetchone() — sqlite3.OperationalError: no such table: users
   [primary] service.py:25 → result = query_db(user_id) — RuntimeError: Database query failed
 ```
 
 ### Part 2：相关源代码
 
 ```
 ## Source Context
 
 ### main.py:85-125 (P0, error location)
 <code>
 ### db.py:5-15 (chain root cause)
 <code>
 ```
 
 ### Part 3：分析指令
 
 ```
 ## Instructions
 
 Return a JSON object with the following fields:
 1. translation: 中文翻译报错信息, 用 {{keyword}} 包裹英文术语
 2. keywords: [{cn, en}] 中英术语对照表
 3. analysis: 中文根因分析, 必须引用具体行号 (格式: "文件:行号")
 4. fixSuggestion: 中文修复建议, 文字描述, 不需要代码
 ```
 
 ## 九、存储与缓存
 
- 缓存位置：`~/.errAnalyst/cache.json`
- 缓存上限：200 条
- 匹配策略：自动分析不查询缓存，每次报错分析都调用 AI；缓存仅作为历史记录，通过缓存查阅/错误历史展示
- 缓存内容：translation、keywords、analysis、fixSuggestion（无 fixCode）
- 错误历史列表通过缓存数据展示
 
 ## 十、文件结构
 
 ```
 src/
 ├── extension.ts             ← 入口
 ├── config.ts                ← 类型定义 + Config 单例
 ├── terminalWatcher.ts       ← 调整后触发策略
 ├── parser/
 │   ├── index.ts             ← 导出 ParsedTraceback / StackFrame / ChainEntry
 │   ├── pythonTraceback.ts   ← parse() 实现
 │   └── error-categories.yaml  ← 错误类别规则
 ├── context/
 │   ├── contextBuilder.ts    ← 统一积分方案
 │   └── scorer.ts            ← 积分计算逻辑
 ├── llmProvider/
 │   ├── index.ts
 │   ├── types.ts             ← 去掉 FixAction 相关
 │   └── openaiCompatible.ts  ← prompt 按新结构重写
 ├── ui/
 │   ├── analysisWebview.ts
 │   ├── errorHistoryView.ts
 │   └── hoverProvider.ts
 ├── storage/
 │   └── errorMemory.ts
 └── diagnostics/
     └── categoryClassifier.ts  ← YAML + AI fallback
 ```
 
 ### 移除的模块
 
 - `fixProvider.ts` — 整个文件
 - `errorLinkProvider.ts` — 已归入新的触发流，其终端链接提供功能由 `terminalWatcher` 接管
 - `FixAction`、`FileEdit`、`CommandAction` 等类型
 - `fixCode` / `fixFile` / `fixImports` / `fixLine` / `actions` 字段
 - `errAnalyst.showFixDiff` / `applyFix` 命令
 - Webview 中的应用修复按钮和 actions 区域
 - HoverProvider 中的修复链接
 
 ## 十一、未来（全语言阶段）扩展点
 
 以下接口已在第一阶段预留，后续语言扩展时无需重构：
 
 - `identify()` 的空壳接口
 - `categoryClassifier` 的语言级规则嵌套（`error-categories.yaml` 可扩展语言维度）
 - `contextBuilder` 优先级积分方案（新语言加新类型的候选来源和分值）
 - `terminalWatcher` 触发策略（全语言时 exitCode 为主触发）
