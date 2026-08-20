# ErrAnalyst 交接文档

> 下回开始会话前，先读这个文件。

---

## 项目目标

ErrAnalyst 是一个 VSCode 插件，核心功能：

1. **自动捕获终端 Python 报错**（exitCode ≠ 0 时自动触发）
2. **解析 traceback** 提取错误类型、栈帧、文件行号
3. **构建代码上下文** 按优先级积分挑选相关源码
4. **调用 LLM**（DeepSeek/Kimi/Qwen）分析错误并给出中文翻译、根因分析、修复建议
5. **侧边栏 Webview** 展示结果 + 编辑器 Hover 悬浮显示

---

## 已完成的工作

### Prompt 层（`src/llmProvider/openaiCompatible.ts`）

- 重写 `buildUserPrompt`，新增 `## Original Traceback` 兜底——无论解析器是否成功，**原始 traceback 原文永远发给 LLM**
- 解析出的结构化数据改为 `## Parsed Error Data` 做补充显示
- Instruction 中强调优先使用完整原文

### TerminalWatcher 层（`src/terminalWatcher.ts`）

**四层触发机制（按优先级）：**

| 编号 | 事件 | 作用 | 当前状态 |
|------|------|------|----------|
| 触发 1 | `onDidEndTerminalShellExecution` | 读取 execution 流，非零 exitCode 调用 checkForError | ⚠️ buffer 空（流被触发 4 消费），加了日志 |
| 触发 2 | `TerminalLinkProvider` | 逐行识别错误 | ✅ 仅追加到 lineBuffers，不主动调用 |
| 触发 3 | `onDidWriteTerminalData` | 实时捕获终端写入 | ⚠️ proposal API，需 `enabledApiProposals` |
| 触发 4 ⭐ | `onDidStartTerminalShellExecution` | 读取 execution 流 + 1500ms 延迟 + 对比 lineBuf/execBuf | ✅ **唯一实际工作路径** |

**修复清单：**

1. **闭包竞态** — `setTimeout` 原来捕获的是调度时刻的 `buf` 快照，改为 `dataDebounceTimers` map + 取消上一定时器 + 回调中从 `lineBuffers` 读最新值（后因去重简化移除了）
2. **数据流冲突** — 触发 4 和触发 1 都在读同一个 `execution.read()` 异步迭代器，先读的人(触发4)拿走全部，后读的人(触发1)拿到空
3. **ANSI 转义码** — 终端数据包含 `\x1b]633;C\x07`(OSC)、`\x1b[0m`(SGR)、`\r\n`，导致 `startsWith('Traceback')` / `startsWith('File "')` 全部失效。在 `processBuffer` 入口加了 `stripAnsi()` + `\r\n→\n`
4. **去重** — 触发 2/3 各自调度定时器调用 `checkForStreamData`，移除它们的主动调用权，统一由触发 4 的 1500ms 定时器处理
5. **`enabledApiProposals`** — 之前通过 `cat | python3 -c` 方式"添加"但实际没写回文件，现在已补齐

---

## ⚠️ 当前卡住的问题

### 核心问题：execution.read() 截断

`onDidStartTerminalShellExecution` 的 `execution.read()` 只返回了 423 字节的单个 chunk，**traceback 的最后一行 `ZeroDivisionError: division by zero` 不在其中**。shell integration 在 PTY 缓冲区还没刷完时就关闭了数据流。

### 根因

`onDidWriteTerminalData`（触发 3）是唯一能拿到完整终端输出的 API，但它是一个 **VSCode proposal API**，需要在 `package.json` 中声明：

```json
"enabledApiProposals": ["terminalDataWriteEvent"]
```

这个声明**之前没写进去**（`cat | python3 -c ...` 只是打印到 stdout），现在刚补上。**下回会话需要重载 VSCode 后验证它是否生效。**

如果生效，触发 3 会持续往 `lineBuffers` 追加完整数据，触发 4 的 1500ms 定时器会取到完整的 traceback（包括最后一行）。

### 当前实际工作路径

由于 `onDidWriteTerminalData` 不可用，当前唯一工作路径是：

触发 4 读 `execution.read()` → `execBuffer`（423 字节，缺最后一行）→ `stripAnsi()` → `processBuffer` → parser 能提取栈帧和文件路径 → `contextBuilder` 能读取源码 → Prompt 有代码上下文但错误类型是回退的 "Error"

---

## 下一步计划

### 1. 验证 `enabledApiProposals` 是否生效

重载 VSCode 后，看控制台是否有：

```
TerminalWatcher: onDidWriteTerminalData IS available
TerminalWatcher: onDidWriteTerminalData got data: ...
```

### 2. 如果生效：调优触发 4 的 lineBuf 对比逻辑

当前触发 4 的 1500ms 定时器会对比 `lineBuf` 和 `execBuffer` 取更长的。如果 `onDidWriteTerminalData` 开始工作，`lineBuf` 会远长于 `execBuffer`。可以简化掉 `execBuffer` 的回退逻辑。

### 3. 如果仍然不可用：换方案

- 方案 A：在 `extractErrorBlock` 中增加"不完整 traceback 等待重试"逻辑——如果解析不出 error type，等一段时间再试
- 方案 B：使用 `vscode.window.onDidWriteTerminalData` 的另一种调用方式（如果 proposal API 签名不同）
- 方案 C：让测试在已知的 `main.py`（项目根目录）上跑，数据小的时候截断不明显

### 4. 后续功能

- `## Source Context` 的优先级生效情况是否合理
- 链式异常的支持（`raise X from Y`）
- 多语言支持（Node.js、Go）
- 一键修复（Diff 展示 + apply）

---

## 踩过的坑（不要重复踩）

| 坑 | 教训 |
|----|------|
| **`cat | python3 -c` 不会写回文件** | 要用 `python3 -c '...' && cat > file` 或 `tee` |
| **`execution.read()` 数据不完整** | 永远不要假设 shell integration 的 execution stream 包含完整输出，必须有 fallback |
| **`let` 闭包陷阱** | `setTimeout(() => fn(buf), N)` 中 `buf` 是可变绑定，但值在调度时就已经确定了，不是定时器触发时的最新值。要用 `let` 绑定的引用闭包，或者回调中从变量源读 |
| **`\x1b]633;C` 转义码** | VSCode Shell Integration 会在终端输出中嵌入 OSC 序列，不能用 `startsWith('Traceback')` 直接匹配 |
| **`\r\n` vs `\n`** | 终端数据是 `\r\n`，Linux 端解析只认 `\n`，需要先替换 |
| **`onDidWriteTerminalData` 是 proposal API** | 即使 `@types/vscode` 里有类型定义，运行时也需要 `enabledApiProposals` 声明才能调用 |
| **TypeScript 隐式 `any`** | `(vscode.window as any).onDidWriteTerminalData` 绕过类型检查，但运行时错误只在 Console 里能看到，不仔细看不会发现 |
| **触发 1 和触发 4 竞争同一个 stream** | `execution.read()` 是单次消费的 AsyncIterable，不能两个 handler 同时读 |
| **`processBuffer` 防抖基于 errorKey** | 如果两次调用的 `errorKey` 不同（如一次回退为 "Error"、一次正确解析为 "ZeroDivisionError"），防抖不会拦截第二次 |

---

## 文件结构

```
src/
├── extension.ts              ← 入口，模块初始化 + 主流程编排
├── config.ts                 ← Config 单例 + ErrorAnalysisResult 接口
├── terminalWatcher.ts        ← 核心：4 层触发 + 转义码剥离 + 缓冲区管理
│
├── parser/
│   ├── index.ts              ← ParsedTraceback / StackFrame 类型
│   ├── pythonTraceback.ts    ← 纯文本 traceback 解析器（正则 + 逐行扫描）
│   └── error-categories.yaml ← 错误类别规则
│
├── context/
│   ├── contextBuilder.ts     ← 优先级积分贪心挑选源代码
│   └── scorer.ts             ← 积分计算逻辑
│
├── llmProvider/
│   ├── index.ts              ← 工厂函数
│   ├── types.ts              ← LlmProvider 接口
│   └── openaiCompatible.ts   ← OpenAI 兼容格式调用 + Prompt 构建 + 响应解析
│
├── diagnostics/
│   └── categoryClassifier.ts ← YAML 规则匹配 → UNKNOWN 则 fallback AI
│
├── storage/
│   └── errorMemory.ts        ← 本地缓存 ~/.errAnalyst/cache.json
│
└── ui/
    ├── analysisWebview.ts    ← Webview 侧边栏面板
    ├── errorHistoryView.ts   ← 错误历史列表
    ├── hoverProvider.ts      ← 编辑器内 Hover 显示
    └── errorLinkProvider.ts  ← 终端链接提供器
```

---

## 快速启动

```bash
cd /Users/a1/Desktop/errAnalyst

# 编译
npm run compile

# 测试（目前 main.py 内容是 1/0）
python3 main.py

# 查看日志
# VSCode 中 Cmd+Shift+P → "Developer: Toggle Developer Tools" → Console 面板
```

---

## 最近 Git 提交

```
03646a0 fix: 修复多条路径竞争捕获报错问题
e4e4553 fix：拼接的prompt中可以正确拿到代码上下文
b7d4fe6 feat: 正确捕获报错
75ecdf3 需求完成细化，第一次搭建
```
