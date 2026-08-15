# ErrAnalyst - 错误智能分析

试图解决报错需复制粘贴到 AI 的最后一步路问题。

智能分析 Python 报错，定位代码位置，AI 翻译错误信息、提供一键修复的 VS Code 扩展。终端里出现 Traceback 时自动分析根因，给出中文翻译、修复建议与可确认的代码补丁；内置错误分析对话，并支持长期/短期记忆让后续分析贴合你的习惯。

## 功能特性

- 自动捕获报错：能自动捕获终端中的 Python 报错（Traceback），无需手动复制
- 自动添加上下文：能够自动定位报错中对应的代码位置，并将相关的上下文一并捕获
- 报错分析：AI 翻译错误信息、解释报错原因，输出核心报错术语中英对照，同时提供修复建议
- 一键修复：生成修复补丁与 diff 预览，逐处确认后写入
- 错误分析对话：围绕当前报错追问，可根据对话内容提出的修复方案生成修复补丁
- 本地缓存：保留错误历史，支持重复查看
- 记忆系统：短期记忆（会话滚动摘要）、长期记忆（修复偏好、修复建议偏好、错误分析偏好、常犯错误统计）
- 多 AI 提供商：DeepSeek、Kimi (Moonshot)、Qwen（通义千问），支持任意 OpenAI 兼容 API
- 支持配套 CLI 命令（`erranalyst`）

## 本地部署

### 环境要求

| 依赖 | 版本 / 说明 |
| --- | --- |
| VS Code | ≥ 1.96.0（扩展声明的最低版本） |
| Node.js | ≥ 18，建议 20.x LTS（编译、打包与 CLI 均依赖 npm） |
| Python | ≥ 3.x（触发并分析报错的前置条件，扩展本身不绑定具体 Python 版本） |
| 终端 Shell 集成 | 开启 VS Code 终端 Shell Integration，否则无法自动捕获报错 |
| AI 服务 | 任一 OpenAI 兼容 API 的 Base URL 与 API Key（如 DeepSeek / Kimi / Qwen） |
| 操作系统 | macOS / Linux 可直接使用安装脚本；Windows 下 CLI 脚本需 Git Bash 或 WSL |

### 方式一：源码部署（开发调试）

1. 克隆仓库并安装依赖：

   ```bash
   git clone https://github.com/X-futur/errAnalyst.git
   cd errAnalyst
   npm install
   ```

2. 编译：

   ```bash
   npm run compile
   ```

   开发时也可以使用监听模式，改代码自动重编译：

   ```bash
   npm run watch
   ```

3. 在 VS Code 中打开项目，按 `F5` 启动"扩展开发宿主"（Extension Development Host），即会加载本仓库的扩展。

4. 配置 AI 提供商：首次激活时若无可用 Provider，会自动弹出配置向导；也可以在命令面板运行 `erranalyst provider set`，或在终端执行：

   ```bash
   erranalyst provider set
   ```

> **附加说明**：该 `bash` 命令若在终端运行需安装配置CLI，下文同理

5. 验证：在集成终端运行一个会报错的 Python 脚本（如 `python3 main.py`），侧边栏应自动展示错误分析。

### 方式二：打包 VSIX 安装（发布路径）

1. 在仓库`release`处下载`VSIX`文件

2. 安装到 VS Code：

   - 打开扩展视图（`Cmd/Ctrl + Shift + X`）→ 右上角 `...` → **Install from VSIX...** → 选择 `.vsix` 文件；
   - 或命令行安装：

     ```bash
     code --install-extension err-analyst-0.1.0.vsix
     ```

3. 重新加载窗口后根据配置向导进行配置，或运行 `erranalyst provider set` 配置 AI 提供商。

> 说明：VSIX 只包含编译产物，源码部署和 VSIX 部署可同时存在；开发调试（F5）与正式安装互不影响。

## CLI 部署

`erranalyst` 命令提供 Provider 配置、缓存查看、记忆管理等功能。VSIX 安装不会自动把 CLI 加入 PATH，需要按下面任选一种方式部署。

### 方式一：安装脚本（推荐，配合 VSIX 使用）

需从 `release` 界面获取到 `install-cli.sh` 文件，并执行：

```bash
# 浏览器/命令行下载不会保留 Unix 执行位，先补上可执行权限
chmod +x install-cli.sh
./install-cli.sh
source ~/.zshrc
```

> 提示：若下载后权限仍是 `-r--r--r--`，也可以不改权限，直接用 `bash install-cli.sh` 运行，效果相同。

脚本会在 `~/.local/bin` 安装一个动态 wrapper，并把该目录写入 shell 配置（`~/.zshrc` / `~/.bashrc`），新开终端后生效。wrapper 每次执行时自动定位 VS Code 扩展目录中**最新安装**的 errAnalyst 扩展来运行，因此以后升级扩展无需重新运行本脚本。

验证：

```bash
erranalyst help
```

卸载：

```bash
./install-cli.sh uninstall
```

该命令会删除 wrapper 并清理 shell 配置中的 PATH 标记。

### 方式二：npm 全局（推荐，配合源码开发使用）

开发期间希望 CLI 直接跟随仓库代码，可以使用 npm 全局链接：

```bash
cd /path/to/errAnalyst
npm link
```

等价于全局安装到 npm 全局 bin 目录（如 `~/.npm-global/bin`）。链接模式无需重复执行，仓库代码改动立即生效。若需要正式全局安装（不依赖链接）：

```bash
npm install -g /path/to/errAnalyst
```

### PATH 优先级与冲突处理

同一台机器可能同时存在两套 CLI（安装脚本的 wrapper 与 npm 全局链接）。命令解析按 `PATH` 顺序，`~/.local/bin` 通常排在 npm 全局 bin 之前，因此 wrapper 优先。

- 想用 npm 全局的那套：先卸载 wrapper（`./install-cli.sh uninstall`），新开终端后 `command -v erranalyst` 应指向 npm 全局 bin；
- 想保留 wrapper：直接使用即可，它始终运行扩展目录里的最新版本。

验证当前生效的版本位置：

```bash
which -a erranalyst
command -v erranalyst
erranalyst help
```

## 使用

安装并配置好 AI 提供商后，在集成终端运行 Python 脚本，报错时会自动进行分析。也可通过命令面板（`Cmd/Ctrl + Shift + P`）或 CLI 执行以下命令：

> 两者指该命令同时支持 `VS Code command` 和 `CLI` 

| 命令 | 可用位置 | 说明 |
| --- | --- | --- |
| `erranalyst focuspanel show` | VS Code | 打开侧边栏 |
| `erranalyst analyst lasterr` | VS Code | 分析最后一个捕获的错误 |
| `erranalyst cache clear` | 两者 | 清空当前缓存 |
| `erranalyst cache show` | 两者 | 展示本地错误缓存 |
| `erranalyst provider set` | 两者 | 配置 AI 服务提供商及 API Key |
| `erranalyst provider switch` | 两者 | 切换 AI 服务提供商 |
| `erranalyst config show` | 两者 | 展示当前配置信息 |
| `erranalyst model set` | 两者 | 切换 AI 服务提供商的具体模型 |
| `erranalyst memory config` | 两者 | 查看和管理长期记忆（偏好、常犯错误、开关） |

### 记忆系统

- **短期记忆**：当前报错会话的消息历史与滚动摘要，进程内保存、不落盘；历史被截断时自动压缩为摘要，保证早期对话信息不丢失。
- **长期记忆**：持久保存到 `~/.errAnalyst/memory.json`，包含修复偏好（补丁代码怎么改）、修复建议偏好（文字指引怎么给）、错误分析偏好（分析结果怎么讲）与常犯错误统计；按产出类别注入分析、修复补丁与对话提示词。
- **隐式学习**：修复会话中接受的修改处会按"修改原因"聚合，同一原因被接受 ≥2 次自动成为生效偏好，仅 1 次时作为待确认候选。
- **管理**：运行 `erranalyst memory config` 可查看、新增、编辑、删除条目，确认候选，以及开关记忆（设置项 `errAnalyst.memory.enabled`）。

## 配置

首次使用需要配置 AI 提供商（`errAnalyst.providers`）和 API Key，可运行 `erranalyst provider set` 或通过配置向导完成。默认内置 DeepSeek、Kimi、Qwen 三个预设。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `errAnalyst.providers` | 三个预设 | AI 提供商列表（Base URL / Model / API Key） |
| `errAnalyst.activeProvider` | `DeepSeek` | 当前使用的提供商 |
| `errAnalyst.enableCache` | `true` | 保存错误历史（仅作历史查阅，不参与自动分析） |
| `errAnalyst.aiTimeout` | `15000` | AI 请求超时（毫秒） |
| `errAnalyst.enableOneClickFix` | `true` | 启用一键修复功能 |
| `errAnalyst.enableChat` | `true` | 启用错误分析对话 |
| `errAnalyst.memory.enabled` | `true` | 启用长期记忆（关闭后不读取、不写入、不注入提示词） |

本地数据文件：

| 文件 | 内容 |
| --- | --- |
| `~/.errAnalyst/cache.json` | 错误分析缓存（历史查阅，不参与自动分析） |
| `~/.errAnalyst/memory.json` | 长期记忆（偏好与常犯错误统计，参与自动分析） |
| `~/.errAnalyst/credentials.json` | 供 CLI 读取的 API Key 镜像 |

## 许可证

[MIT](LICENSE)
