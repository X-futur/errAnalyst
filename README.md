# ErrAnalyst - 错误智能分析

智能分析 Python 报错，定位代码位置，AI 翻译错误信息并提供一键修复的 VS Code 扩展。

## 功能特性

- 自动捕获终端中的 Python 报错（Traceback）
- 定位报错对应的代码位置，并高亮显示
- AI 翻译错误信息，解释报错原因
- 一键修复：生成修复建议与 diff 预览，确认后应用
- 错误历史与本地缓存，支持重复查看
- 多 AI 提供商：DeepSeek、Kimi (Moonshot)、Qwen（通义千问）
- 同时提供 CLI 命令（`erranalyst`）

## 安装

### 从 VSIX 安装

下载发布页中的 `err-analyst-*.vsix` 文件，然后在 VS Code 中：

1. 打开扩展视图（`Cmd/Ctrl + Shift + X`）
2. 点击右上角 `...` → **Install from VSIX...**
3. 选择下载的 `.vsix` 文件

或使用命令行：

```bash
code --install-extension err-analyst-0.1.0.vsix
```

## 使用

安装后在终端中运行 Python 脚本，报错时会自动进行分析。也可以通过命令面板（`Cmd/Ctrl + Shift + P`）执行以下命令：

| 命令 | 说明 |
| --- | --- |
| `erranalyst focuspanel show` | 打开 erranalyst 侧边栏 |
| `erranalyst analyst lasterr` | 分析最后一个捕获的错误 |
| `erranalyst cache clear` | 清空当前缓存 |
| `erranalyst cache show` | 展示本地缓存 |
| `erranalyst provider set` | 配置 AI 服务提供商及 API Key |
| `erranalyst provider switch` | 切换 AI 服务提供商 |
| `erranalyst config show` | 展示当前配置信息 |
| `erranalyst model set` | 切换 AI 服务提供商的具体模型 |

## 配置

首次使用需要在设置中配置 AI 提供商（`errAnalyst.providers`）和 API Key，或在命令面板中运行 `erranalyst provider set`。默认内置 DeepSeek、Kimi、Qwen 三个提供商的预设。

## 开发

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动扩展开发调试宿主。

## 许可证

[MIT](LICENSE)
