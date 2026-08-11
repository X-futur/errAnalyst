# errAnalyst开发需求流程分析

---

## 你的插件功能拆解

先把你描述的需求翻译成插件开发中的具体任务：

| 你的需求                           | 对应的插件技术点                             |
| :--------------------------------- | :------------------------------------------- |
| 终端报错时自动识别并调用           | 监听终端输出、解析错误信息                   |
| 侧边栏展示错误原文、翻译、修改建议 | 自定义 `Webview` 或 `TreeView` 侧边栏        |
| 多个修改方案 + 一键应用            | 注册命令，调用编辑器 API 修改代码            |
| Diff 展示修改内容                  | 使用 VSCode 内置 Diff API 或自定义 diff 视图 |

---

## 第一阶段：项目初始化与需求梳理

**要做的事（1-2天）：**

1. **明确触发时机**：决定插件在什么**时机**被激活。
   - 方案A：插件常驻后台，持续监听终端输出（适合实时响应）。
   - 方案B：仅在用户执行特定命令时激活（适合按需使用）。

   根据官方 API 文档，你可以通过 `vscode.window.onDidWriteTerminalData` 监听终端输出。建议采用**方案A**，让插件在终端有输出时就自动工作。

2. **选择核心依赖**：思考是否需要依赖外部 AI 服务（如 DeepSeek、Kimi 等）来分析错误并给出修改建议。
   - 如果**本地运行**，需要自己实现错误匹配逻辑（比如正则匹配常见错误）。
   - 如果**调用 AI API**，需要申请 API Key，并处理好上下文传递（把错误信息和当前文件代码一起发给 AI）。

3. **画一个简单的流程图**（手绘或用 draw.io）：把“终端报错 → 解析错误 → 调用AI/规则 → 侧边栏展示建议 → 用户点击一键应用 → 展示 Diff → 应用修改”这个链路画清楚。这一步不要求多精美，关键是让自己理清逻辑。

---

## 第二阶段：原型与交互设计（画什么、怎么画）

**核心产出物：侧边栏的 UI 原型**

1. **用纸笔或 Figma 画出侧边栏的样子**：不需要高保真，画清楚布局就行。参考 Kimi Code 的 VSCode 插件设计，它的侧边栏可以展示对话和代码修改建议，和你想要的功能很接近。你的侧边栏可以包含：
   - **错误原文区域**：展示捕获到的报错信息。
   - **错误翻译区域**：展示通俗解释。
   - **修改建议列表**：每个建议是一个卡片，卡片上有一个“一键应用”按钮。
   - **Diff 预览区域**（点击按钮后弹出或在侧边栏内展开）。

2. **定义交互流程**：
   - 用户点击“一键应用”后，插件应该做什么？（调用 AI/规则生成修改代码 → 弹出 Diff 视图 → 用户确认后写入文件）
   - 参考 **<u>`ai-diff-review-mcp`</u>** 插件的设计：它会把 AI 的修改以 Diff 形式呈现，让用户逐条接受或拒绝。你可以借鉴这个思路，让用户有最终控制权。

---

## 第三阶段：接口与数据设计（“怎么做”）

这个阶段虽然不用画完整的 UML，但有几个关键点必须提前定好：

1. **定义插件与 AI 服务的接口**：
   - 如果你调用外部 AI API，需要定义**输入参数**（错误信息 + 当前文件内容 + 项目上下文）和**输出格式**（返回的修改建议至少包含：修改原因、修改后的代码片段、影响范围）。
   - 如果你自己写规则，则需要建立一个**错误-解决方案映射表**（可以先做成 JSON 文件）。

2. **定义插件内部的数据结构**：
   ```typescript
   interface ErrorSuggestion {
     originalError: string;      // 错误原文
     translation: string;        // 翻译
     solutions: Solution[];      // 多个方案
   }
   
   interface Solution {
     description: string;        // 方案描述
     codeChanges: CodeChange[];  // 要修改的代码列表（文件路径 + 修改后的内容）
   }
   
   interface CodeChange {
     filePath: string;
     originalCode: string;       // 修改前（用于生成 Diff）
     modifiedCode: string;       // 修改后
   }
   ```

---

## 第四阶段：开发与调试（写代码 + 自测）

**开发步骤建议（按顺序推进）：**

1. **创建项目骨架**：使用官方推荐的 `Yo` 脚手架生成 TypeScript 项目。
   ```bash
   npx --package yo --package generator-code -- yo code
   ```
   选择 TypeScript，按提示填写插件名称、描述等信息。

2. **实现终端监听**（核心难点）：参考 Continue 插件的实现方式，通过 VSCode 的 Shell Integration API 捕获终端输出。
   ```typescript
   // 伪代码示例
   const terminal = vscode.window.createTerminal('ErrorMonitor');
   terminal.sendText('your command');
   // 监听终端数据
   vscode.window.onDidWriteTerminalData((event) => {
       const output = event.data;
       // 解析 output，判断是否包含错误信息
       if (isError(output)) {
           handleError(output);
       }
   });
   ```
   这里需要处理远程环境（SSH、WSL、Dev Container）下的终端输出捕获问题，Continue 的 PR 提供了很好的参考实现。

3. **实现错误解析与 AI 调用**：
   - 把捕获到的错误信息和当前打开的文件内容一起发给 AI（如 DeepSeek API）。
   - 解析 AI 返回的 JSON，填充到 `ErrorSuggestion` 数据结构中。

4. **实现侧边栏（Webview）**：开发一个 `Webview` 面板来展示错误分析结果和修改建议。这里需要处理 `Webview` 和插件主进程之间的通信（用 `postMessage` 机制）。

5. **实现“一键应用” + Diff 展示**：
   - 当用户在侧边栏点击某个方案的按钮时，`Webview` 向插件主进程发送消息，携带要修改的文件路径和新代码。
   - 插件主进程使用 `vscode.diff` API 或集成 `ai-diff-review-mcp` 这样的现成 MCP 服务来展示 Diff。或者参考 `vscode-diff-merge` 扩展的设计思路，构建一个可视化 Diff 面板，让用户确认修改。
   - 用户确认后，使用 `vscode.workspace.fs` 或 `TextEditor.edit` 将修改写入文件。

6. **自测**：模拟不同的错误场景，验证整个流程是否通畅。

---

## 第五阶段：打包与发布（可选）

如果你想把插件分享给其他人使用：

1. **安装打包工具**：`npm install -g vsce`。
2. **打包**：在项目根目录运行 `vsce package`，会生成一个 `.vsix` 文件。
3. **安装**：在 VSCode 中，点击扩展面板右上角的 `...` → `从 VSIX 安装...`，选择你打包好的文件即可。
4. **发布到市场**（可选）：如果你想把插件上架到 VSCode Marketplace，需要注册一个发布者账号，然后用 `vsce publish` 发布。

---

## 🚀 给你的实操建议

一个人开发，**时间是最大的成本**，所以一定要**砍掉不必要的步骤**：

1. **原型图**：画清楚布局和交互即可，不用搞高保真。
2. **需求文档**：用 Markdown 写一个简单的 README，记录核心流程和功能点，比写几百页 Word 文档有用得多。
3. **设计文档**：只画**数据流图**（终端 → 解析 → AI → 侧边栏 → 应用）和**数据结构定义**（TypeScript Interface），其他 UML 图全部省略。
4. **测试**：重点测试**终端监听**和**Diff 展示**这两个最核心、最容易出 Bug 的功能。

**第一版 MVP（最小可行产品）的目标**：在一个最简单的场景下（比如运行 Node.js 报错），插件能自动识别、给出一个修改建议、展示 Diff、并成功应用。其他功能（如多方案、复杂错误识别）可以后续迭代。
