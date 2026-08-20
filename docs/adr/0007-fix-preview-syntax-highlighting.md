# 修改预览语法高亮：Prism 扩展侧分词 + scope 对齐 + 双主题配色

Status: accepted

修改预览选项卡原本只渲染纯文本红/绿 diff，用户希望代码能像编辑器一样按编程语言着色，且切换标签页时观感与 VS Code 默认 Python 高亮一致。本决策引入 Prism.js 作为运行时渲染依赖，在扩展侧（Node）对整文件分词、按行拆分成自包含 span，webview 保持哑渲染不动 CSP；并在 Prism token 之上加一层 scope 对齐，把 Prism 的粗粒度分类映射为 VS Code 默认 Python 高亮（MagicPython 语法 + 当前默认主题 Dark 2026 / Light 2026 的实际配色，实测自主题引擎）。色板由扩展在渲染时按 `workbench.colorTheme` 与活动主题类型选择（未配置时默认 2026 双色板；显式使用 Dark+ / Light+ 时切换到经典色板），面板监听主题与配置变化自动重绘，深浅跟随 webview body 的 `vscode-light` / `vscode-dark` class。

Considered Options:
- 自研正则 tokenizer（被否：用户明确选择现成库以换取更高识别质量；手工维护跨语言语法成本高）。
- highlight.js（被否：输出是整段 HTML，适配逐行网格布局需要再写 HTML 按行重切器，跨行 token 易出错；Prism 的 `tokenize()` 返回结构化 token 流，可直接按换行拆分，跨行三引号字符串/块注释天然正确）。
- 接入 VS Code TextMate 语法（`vscode-textmate` + 语法 JSON + oniguruma WASM，被否：实现与体积远超需求，且需要处理 WASM/CSP 加载）。
- 只做大类配色、不细分控制关键字（被否：`if`/`return` 与 `def`/`class` 会撞色，与编辑器不一致，用户要求与默认 Python 高亮一致）。

Consequences:
- 运行时新增 `prismjs` 依赖（扩展侧 require，不进 webview），按需加载 python / javascript / typescript / json / yaml / bash / markdown 组件。
- 高亮范围：Python 完整；JS/TS、JSON/YAML、Shell、Markdown 基础；其余扩展名回退纯文本。
- 色板取自 VS Code 自带主题引擎实测值：默认主题 Dark 2026 / Light 2026（关键字 `def`/`class` 红、控制流 `if`/`return` 紫、字符串蓝、注释灰、函数定义紫、内置调用黄），显式配置 Dark+ / Light+ 时用经典色板（关键字蓝、字符串橙、注释绿）。`print` 等内置调用与函数定义分开着色（`builtin` / `fn`），与 MagicPython 的 `support.function` / `entity.name.function` 对应。
- Prism 的 Python 语法不识别函数调用点，而 MagicPython 会给导入函数调用（如 `query_db(...)`、`os.path.join(...)`）着色；扩展在纯代码区增加“标识符后紧跟 `(`”的调用点识别，异常类名（`ValueError`、`TypeError` 等）与 PascalCase 构造调用按类型着色，字符串/注释内部不参与识别。
- Prism 与 MagicPython 归类差异处（如 `@staticmethod` 装饰器名、raw 字符串、f-string 占位符、`self` 参数位）按最近似类别近似，不做像素级复刻。
- 删除行/新增行保留红/绿底色与删除线，token 颜色覆盖文字色。
- 测试覆盖语言识别、跨行拆分、Python scope 对齐、HTML 转义与行数保持。
