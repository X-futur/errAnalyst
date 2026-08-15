# 配置向导以四个固定卡片为门面，其余提供商归入自定义条目

Status: accepted

配置向导（`ConfigWizard`）的提供商选择固定为 DeepSeek / Kimi / Qwen / 自定义四张卡片，已配置的非预置提供商统一以“自定义提供商”条目出现，支持批量编辑、增删与“设为当前使用”。API Key 只进不出：向导仅回显掩码与“是否已配置”状态，真实 Key 保存在 SecretStorage 与 `~/.errAnalyst/credentials.json`，不在 webview 中传递；用户未重新输入时保存保留原 Key，删除条目或改名时同步迁移/删除 Key。

选择该设计是因为提供商列表是开放的（可任意新增），而向导首屏需要稳定、低认知负荷的入口；Key 不落 webview 避免 XSS 泄露，同时修掉“掩码被当作真实 Key 回存”的既有缺陷。

Considered Options: 把全部提供商渲染成卡片（被否：提供商多时首屏不可维护）；通过独立下拉框选择“当前使用”（被否：与逐条目编辑的心智模型不一致）；保留三步强制测试流程（被否：多条目下测试对象不明确，改为逐条内联测试）。

Consequences: `errAnalyst.providers` 仍以 name 为唯一标识；预置卡片保存即设为激活，自定义条目通过 radio 指定激活；删除激活的自定义条目时激活项回落到剩余第一个提供商；`errAnalyst.setProvider` 等命令与 CLI 入口不受影响。
