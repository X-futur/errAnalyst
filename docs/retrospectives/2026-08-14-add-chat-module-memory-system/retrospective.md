---
title: 添加对话模块记忆系统
date: 2026-08-14
session_id: 01a00081-f4eb-77b3-a35c-01c7a85516d3
source: codex-session
language: zh
---

# 复盘：添加对话模块记忆系统

## 1. 背景与目标

用户要求给 ErrAnalyst 的对话模块加入记忆系统："当前对话模块没有加入记忆系统，应当加入长期记忆和短期记忆，短期记忆用于保存当前会话的上下文，长期记忆用于存储用户修复偏好、用户期望的修复建议偏好、用户期望的错误分析偏好、用户常犯的错误类型等"。

起点状态：对话会话只有进程内消息历史（`ChatSessionManager`，超 20 条/12000 字符截断丢弃），ADR-0002 明确"对话历史不落盘"；已有错误分析缓存 `~/.errAnalyst/cache.json`（明确不参与自动分析）。

## 2. 事件线

- 21:44 会话开始（UTC 13:44）；用户以 `$grill-with-docs` + domain-modeling 发起记忆系统需求。
- 21:44~22:0x 逐题拷问，共 10 个决策，用户全部采纳推荐项（短期记忆=进程内+滚动摘要；长期记忆四类内容；混合来源；全局粒度；memory.json；按类别路由注入；惰性摘要；CLI 管理命令）。
- 22:0x 术语落盘 CONTEXT.md（记忆一节 7 个术语）；ADR-0010 从 proposed 转 accepted；design-v6 记录实现方案。
- 22:1x~22:2x 实现：memory-store、UserMemory、三处 prompt 注入、滚动摘要、隐式学习、errorStats、"memory config" CLI + VS Code 双端；"npm run compile 通过；全部 79 个测试通过"。
- 22:3x 用户询问 CLI 安装情况 → 发现本机存在两套 CLI（`~/.local/bin` wrapper + npm 全局链接）。
- 22:4x README 重写（本地部署、CLI 部署、记忆系统、配置项）。
- 22:5x 打包验证：发现 `.vscodeignore` 排除 `src/**` 导致 `memory-store.js` 会漏包，补白名单；随即发现"打包结果暴露了两个问题：commands.json 和 bin/erranalyst 似乎被回退到了旧版本"。
- 22:5x 排查后确认："真相大白：我们的实现没有丢——被提交到了 `memory` 分支"，master 只有 README；错误产物 VSIX 已删除。
- 23:0x 讲解 GitHub tag + Release 流程；讲解 VSIX 安装后 CLI 的 install-cli.sh 方式。
- 23:1x 检查本机 CLI：当前生效的是 npm 全局软链（指向本地仓库 0.1.1），旧 wrapper 已移除；`err-analyst-0.1.1.vsix` 打包并验证通过；已有 tag `v0.1.0`、`v0.1.1-alpha`。
- 23:2x 用户询问软链开发版如何卸载、从 GitHub 重装最新；随后两次询问 Windows 适配与配置可行性。
- 23:3x 会话结束；用户发起 `$reanalyse` 复盘本会话。

## 3. 五镜头复盘

### 3.1 目标达成度

**判断**：核心目标达成——记忆系统完成设计、实现、文档与打包验证；发布链路还差用户侧的 GitHub Release 与 VS Code 实装，Windows CLI 适配只做了分析未实施。

**证据**："记忆系统按 design-v6 全部实现完成，ADR-0010 已标记为 accepted"；"全部 79 个测试通过"；"`err-analyst-0.1.1.vsix`（1.07 MB）内容检查通过"。

**改进建议**：实现收尾应显式区分"代码完成"与"发布完成"；下次把"端到端验证清单"（F5 实测、`npm test` 完整宿主测试、Release 创建）作为完成定义的一部分，而不是留给后续会话。

### 3.2 决策质量

**判断**：关键决策质量高——逐题单问、每问带推荐答案，10 个决策全部有真实取舍且记录在 ADR-0010；但"None 保护 / None 检查 判重"这一设计例子的语义合理性存疑，实现时才暴露。

**证据**：设计文档原文"（如 'None 保护' 与 '添加 None 检查' 视为同一条）"；实现时"第一个测试失败……'none保护' !== 'none检查'"，最终靠后缀归一化（检查/保护/校验→防护）强行合并。

**改进建议**：设计阶段对"判重归一化"这类规则应先用 5~8 个反例做验证（删除/添加、检查/保护是否真的同义），而不是把有争议的例子直接写进文档；隐式学习合并过宽的代价是偏好污染，宁可不合并。

### 3.3 效率与过程

**判断**：总体高效（复用 err-store 模式、design-v5 文档模式、commands.json 双端注册），但打包环节有一次可避免的返工：未在打包前核对 git 分支状态，先在 master 上打出了缺功能的"假包"。

**证据**："打包成功了，但有个疑点：这次同步显示 8 个命令，之前是 9 个"；随后"整个实现被外部回退掉了……被提交到了 `memory` 分支"。

**改进建议**：凡是"打包/发布"类动作，第一步先 `git status -sb && git branch --show-current && git log origin/master..master`；并把"打包后 unzip 检查关键文件"固化成发布清单第一步（本次就是靠这个检查救回来的）。

### 3.4 风险与坑

**判断**：踩中两个真实坑（`.vscodeignore` 漏包 CLI 依赖、实现与 README 分处两个分支），另有三个未暴露隐患（Windows CLI 不适配、tag 与版本号不一致、扩展本体仍是 0.1.0）。

**证据**：".vscodeignore 把 `src/**` 排除了，只放行了 err-store，而我们新增的 `memory-store.js` 会被打掉"；"VS Code 扩展本体……装的还是旧版 `erranalyst.err-analyst-0.1.0`"；"已有 tag：`v0.1.0`、`v0.1.1-alpha`"。

**改进建议**：把"CLI 依赖文件白名单"做成打包测试断言（`unzip -l` + grep，失败即 CI 红）；Windows 适配未做前，README 必须明确"CLI 配置类命令仅 macOS/Linux"；正式发版前统一 tag 命名（v0.1.1 而非 v0.1.1-alpha）。

### 3.5 协作与交接

**判断**：人机配合在"git 操作"环节出现信息断点——用户侧提交/切分支未同步给 agent，导致 agent 一度误判实现被回退；文档交接物齐全，但发布相关动作仍依赖人类拍板。

**证据**："你（或你的工作流）做了这些 git 操作：`memory` 分支……`master` 只有新的 README"；最终交接状态为"需人类决策"（GitHub Release、Windows 适配、VS Code 装新版）。

**改进建议**：约定协作规则——用户做 git 提交/切分支后告知 agent 一次（"已提交到 X 分支"），agent 在关键里程碑（打包、发布）前主动核对 git 状态；把 release 决策做成明确的待办交接项而非口头提醒。

## 4. 可复用经验

1. 打包/发布前先核对 `git status -sb`、当前分支与远程差异，再执行 `npm run package`；打包后必须 `unzip -l` + grep 验证 CLI 依赖与关键命令在包内。
2. `.vscodeignore` 排除 `src/**` 时，凡 CLI 运行时 `require` 的 `src/shared/*.js` 都要显式白名单，否则 VSIX 内 CLI 必然缺模块。
3. 设计文档里写"归一化判重/同义合并"这类规则前，先跑一组正反例验证语义边界，避免把有争议的例子固化进文档。
4. 双分支并存时先确认"要发布的内容在哪个分支"，合并后再打包，避免打出缺功能的版本。
5. 跨平台结论要区分"扩展本体"与"CLI"两套事实分别下结论；CLI 的 macOS 专属逻辑（settings 路径、`security`、bash 脚本）要逐条列出并给出 Windows 替代方案。
