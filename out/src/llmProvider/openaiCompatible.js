"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAICompatibleProvider = void 0;
exports.buildAnalysisPrompts = buildAnalysisPrompts;
exports.parseAiResponse = parseAiResponse;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const url_1 = require("url");
class OpenAICompatibleProvider {
    constructor(config) {
        this.name = config.name;
        this.config = config;
    }
    async analyze(request) {
        const { systemPrompt, userPrompt, timeout } = request;
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const url = new url_1.URL(`${baseUrl}/chat/completions`);
        const body = JSON.stringify({
            model: this.config.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.1,
            max_tokens: 4096
        });
        return new Promise((resolve) => {
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout
            };
            const client = url.protocol === 'https:' ? https : http;
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            resolve({ content: '', success: false, error: parsed.error.message });
                            return;
                        }
                        const content = parsed.choices?.[0]?.message?.content || '';
                        // DEBUG: print full LLM response to terminal
                        console.log('=== ErrAnalyst LLM 完整返回 ===');
                        console.log(content);
                        console.log('=== End ===');
                        resolve({ content, success: true });
                    }
                    catch (e) {
                        resolve({ content: '', success: false, error: `JSON parse error: ${e}` });
                    }
                });
            });
            req.on('error', (e) => {
                resolve({ content: '', success: false, error: `Request failed: ${e.message}` });
            });
            req.on('timeout', () => {
                req.destroy();
                resolve({ content: '', success: false, error: 'Request timeout' });
            });
            req.write(body);
            req.end();
        });
    }
}
exports.OpenAICompatibleProvider = OpenAICompatibleProvider;
function buildAnalysisPrompts(result, category, context) {
    const categoryVal = category || result.category || 'RUNTIME_ERROR';
    return buildPromptByCategory(result, categoryVal, context);
}
function buildPromptByCategory(result, category, context) {
    return { systemPrompt: buildSystemPrompt(category), userPrompt: buildUserPrompt(result, category, context) };
}
function buildSystemPrompt(category) {
    const roles = {
        COMPILATION_ERROR: '你是 TypeScript/JavaScript 编译错误分析专家。专注于类型错误、语法错误和 ESLint 违规。',
        DEPENDENCY_ERROR: '你是包管理依赖分析专家。熟悉 npm、yarn、pnpm、pip 依赖冲突。',
        SYSTEM_ERROR: '你是系统环境配置专家。专注端口冲突、权限问题、命令缺失、环境变量。',
        RUNTIME_ERROR: '你是运行时错误分析专家。可以解析 Python、JavaScript、TypeScript 等多种语言的堆栈跟踪。',
        UNKNOWN: '你是通用错误分析专家。根据终端输出和项目配置文件推断项目类型和错误根因。',
    };
    const roleText = roles[category] || roles.UNKNOWN;
    // 输出格式：JSON，字段包括 errorType, errorMessage, translation, keywords[], analysis, fixSuggestion, actions[](edit_file/run_command/info_only)
    return '你是ErrAnalyst错误分析助手。分类：' + category + '。' + roleText + ' 输出JSON格式，字段：errorType,errorMessage,translation(用{{keyword}}包裹术语),keywords[{cn,en}],analysis(中文分析),fixSuggestion(中文建议),actions[{type,title,description,edits[],commands[]}]。actions支持edit_file(edits:[{file,startLine,endLine,newText}])、run_command(commands:[{cmd,cwd,description,autoApprove}])、info_only。';
}
function buildUserPrompt(result, category, context) {
    const labels = {
        COMPILATION_ERROR: '🛠️ 编译错误', DEPENDENCY_ERROR: '📦 依赖错误',
        SYSTEM_ERROR: '⚙️ 系统错误', RUNTIME_ERROR: '▶️ 运行时错误', UNKNOWN: '❓ 未知',
    };
    let lines = [];
    // ═══ 第1部分：报错文件（最重要，放开头）═══
    if (context && context.mainFile) {
        lines.push('## 报错文件');
        lines.push('路径：' + context.mainFile.path);
        lines.push('（第' + context.mainFile.startLine + '-' + context.mainFile.endLine + '行，>>>标记报错行所在位置）');
        lines.push('```');
        lines.push(context.mainFile.content);
        lines.push('```');
        lines.push('');
    }
    else {
        // 保底：直接从终端输出提供信息
        lines.push('## 终端输出');
        lines.push('```');
        lines.push((result.fullTraceback || '').slice(0, 2000));
        lines.push('```');
        lines.push('');
    }
    // ═══ 第2部分：其他相关文件 ═══
    if (context) {
        const otherFiles = [];
        for (const f of context.relatedFiles) {
            if (context.mainFile && f.path === context.mainFile.path)
                continue;
            otherFiles.push(f);
        }
        if (otherFiles.length > 0 || context.configFiles.length > 0) {
            lines.push('## 相关代码');
            for (const f of otherFiles.slice(0, 3)) {
                lines.push('');
                lines.push('### ' + f.path + '（第' + f.startLine + '-' + f.endLine + '行）');
                lines.push('```');
                lines.push(f.content);
                lines.push('```');
            }
            for (const f of context.configFiles.slice(0, 3)) {
                lines.push('');
                lines.push('### ' + f.path);
                lines.push('```');
                lines.push(f.content);
                lines.push('```');
            }
            lines.push('');
        }
    }
    // ═══ 第3部分：终端输出（精简） ═══
    // 如果已经有了报错文件，终端输出精简到1500字符
    if (context && context.mainFile) {
        lines.push('## 终端输出（精简）');
        lines.push('```');
        lines.push((result.fullTraceback || '').slice(0, 1500));
        lines.push('```');
        lines.push('');
    }
    // ═══ 第4部分：调用栈 ═══
    if (result.stackFrames.length > 0) {
        lines.push('## 调用栈');
        for (const frame of result.stackFrames.slice(0, 5)) {
            lines.push('  ' + frame.file + ':' + frame.line + ' ' + frame.function);
        }
        lines.push('');
    }
    // ═══ 第5部分：分析指令（放结尾，利用LLM的"近因效应"） ═══
    lines.push('## 分析指令');
    lines.push('对以上提供的信息做以下分析：');
    lines.push('');
    lines.push('1. 从报错文件开始，逐行检查报错位置附近的代码，找出导致错误的根本原因');
    lines.push('2. 在analysis字段中必须引用【具体行号】来说明问题所在（格式："文件:行号 处的代码XXX"）');
    lines.push('3. 不允许使用"某行""某位置""某处"等模糊表述——具体行号就在你面前');
    lines.push('4. 如果其他相关文件中有引起问题的代码，一并分析引用');
    lines.push('5. fixSuggestion必须给出明确的修改方案，包括改哪个文件的哪一行、改成什么');
    lines.push('6. 如果是依赖/配置问题，给出具体的配置修改或命令');
    lines.push('');
    lines.push('返回JSON。');
    return lines.join('\n');
}
function parseAiResponse(content) {
    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return null;
        const data = JSON.parse(jsonMatch[0]);
        return {
            errorType: data.errorType || '',
            errorMessage: data.errorMessage || '',
            translation: data.translation || '',
            keywords: data.keywords || [],
            analysis: data.analysis || '',
            fixSuggestion: data.fixSuggestion || '',
            fixCode: typeof data.fixCode === 'string' ? data.fixCode : '',
            fixFile: typeof data.fixFile === 'string' ? data.fixFile : '',
            fixImports: Array.isArray(data.fixImports) ? data.fixImports : [],
            fixLine: typeof data.fixLine === 'number' ? data.fixLine : 0,
            actions: Array.isArray(data.actions) ? data.actions : undefined,
        };
    }
    catch (e) {
        console.error('ErrAnalyst: Failed to parse AI response', e);
        return null;
    }
}
//# sourceMappingURL=openaiCompatible.js.map