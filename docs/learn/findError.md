// ============================================================
//  VS Code 终端报错识别工作流（版本 1.0）
//  输入: terminalOutput (终端的全部报错文本)
//  输出: errorCategory (错误类别) + actionPlan (处理建议)
// ============================================================

FUNCTION identifyError(terminalOutput):
    
    // -------- 第 0 步：预处理（清理干扰信息） --------
    cleanOutput = 移除所有 "---" 或 "=====" 分割线
    cleanOutput = 移除所有时间戳（如 [2026-07-12 10:00:00]）
    
    // 提取关键行：第一行报错 + 最后 10 行 + 包含 "Error" 或 "ERR" 的行
    firstErrorLine = cleanOutput 中第一个匹配 /Error|ERR|Failed|Exception/ 的行
    lastTenLines = cleanOutput 的最后 10 行
    allErrorLines = cleanOutput 中所有匹配 /Error|ERR|Failed|Exception/ 的行
    
    // -------- 第 1 步：检查退出码（快速过滤） --------
    IF lastTenLines 匹配 /exit code [1-9]\d*|terminated with status [1-9]\d*|Process exited with code [1-9]/i:
        // 但不要立即下结论，这是"症状"不是"病因"
        SET isExitCodeError = TRUE
        // 继续往下分析，但提醒用户往上翻日志
    ELSE:
        SET isExitCodeError = FALSE
    
    // -------- 第 2 步：根据关键词分类（核心判断逻辑） --------
    
    // 2.1 检查是否是"编译/构建错误"（优先级最高，因为发生在运行前）
    IF firstErrorLine 匹配 /TS\d{4,}|ESLint|Failed to compile|SyntaxError.*unexpected/i:
        category = "COMPILATION_ERROR"  // 第 2 类
        actionPlan = "检查 TypeScript 类型或 ESLint 规则，修复语法"
        GOTO 生成报告
    
    // 2.2 检查是否是"依赖/包管理错误"
    IF firstErrorLine 匹配 /npm ERR!|pip install|yarn add|Module not found|ERESOLVE|ECONNRESET/i:
        category = "DEPENDENCY_ERROR"   // 第 4 类
        actionPlan = "检查 package.json / requirements.txt，重新安装依赖或清理缓存"
        GOTO 生成报告
    
    // 2.3 检查是否是"系统/环境错误"
    IF firstErrorLine 匹配 /command not found|EADDRINUSE|Permission denied|Cannot find module 'node'/i:
        category = "SYSTEM_ERROR"       // 第 3 类
        actionPlan = "检查环境变量、端口占用或文件权限"
        GOTO 生成报告
    
    // 2.4 检查是否是"运行时错误"（兜底逻辑）
    IF firstErrorLine 匹配 /ReferenceError|TypeError|RangeError|Cannot read property|is not a function|undefined/i:
        category = "RUNTIME_ERROR"      // 第 1 类
        actionPlan = "检查变量定义、数据类型或异步逻辑"
        GOTO 生成报告
    
    // -------- 第 3 步：如果关键词无法匹配，用路径特征辅助判断 --------
    SET hasFilePath = firstErrorLine 匹配 /([a-zA-Z]:\\[^\s]+\.(js|ts|py|java|go)|[^\s]+\.(js|ts|py):\d+)/i
    
    IF hasFilePath == TRUE:
        // 有文件路径说明能定位到代码 → 大概率是运行时或编译错误
        IF category 未定义:
            category = "RUNTIME_ERROR (推测)"
            actionPlan = "查看第一个包含文件路径的行，按住 Ctrl 点击跳转"
    ELSE:
        // 没有文件路径 → 大概率是环境或依赖问题
        IF category 未定义:
            category = "SYSTEM_OR_DEPENDENCY_ERROR (推测)"
            actionPlan = "检查命令是否正确、环境变量是否配置、网络是否通畅"
    
    // -------- 第 4 步：生成最终报告 --------
    生成报告:
        RETURN {
            category: category,
            isExitCode: isExitCodeError,
            actionPlan: actionPlan,
            firstErrorLine: firstErrorLine,
            suggestion: IF isExitCodeError == TRUE:
                "⚠️ 程序以非零退出码结束，请向上滚动找到第一个红色的 'Error:' 行查看具体原因"
            ELSE:
                "按 Ctrl+Shift+Y 打开问题面板，可以看更清晰的错误列表"
        }

// ============================================================
//  使用示例
// ============================================================
terminalOutput = 读取终端全部文本
result = identifyError(terminalOutput)

打印("【错误分类】: " + result.category)
打印("【处理建议】: " + result.actionPlan)
打印("【关键行】: " + result.firstErrorLine)
打印("【补充提示】: " + result.suggestion)