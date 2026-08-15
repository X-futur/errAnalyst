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
exports.buildNonThinkingParams = buildNonThinkingParams;
exports.buildAnalysisPrompts = buildAnalysisPrompts;
exports.sanitizeKeywords = sanitizeKeywords;
exports.parseAiResponse = parseAiResponse;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const url_1 = require("url");
const errorTerms_1 = require("../errorTerms");
class OpenAICompatibleProvider {
    constructor(config) {
        this.name = config.name;
        this.config = config;
    }
    async analyze(request) {
        const { systemPrompt, userPrompt, timeout } = request;
        const safeSystemPrompt = systemPrompt && systemPrompt.trim() ? systemPrompt : '你是 ErrAnalyst 错误分析助手。';
        const safeUserPrompt = userPrompt && userPrompt.trim() ? userPrompt : '请分析本次报错并给出修复建议。';
        return this.complete([
            { role: 'system', content: safeSystemPrompt },
            { role: 'user', content: safeUserPrompt },
        ], timeout);
    }
    async chat(request) {
        const messages = request.messages.length > 0
            ? request.messages
            : [{ role: 'user', content: '你好，请围绕当前报错继续分析。' }];
        return this.complete(messages, request.timeout, request.stream ? request.onChunk : undefined, request.signal);
    }
    complete(messages, timeout, onChunk, signal) {
        const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
        const url = new url_1.URL(`${baseUrl}/chat/completions`);
        const useStream = typeof onChunk === 'function';
        const body = JSON.stringify({
            model: this.config.model,
            messages,
            temperature: 0.1,
            max_tokens: 4096,
            ...(useStream ? { stream: true } : {}),
            ...buildNonThinkingParams(this.config),
        });
        return new Promise((resolve) => {
            let settled = false;
            let content = '';
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                resolve(result);
            };
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
                if (!useStream) {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.error) {
                                finish({ content: '', success: false, error: parsed.error.message });
                                return;
                            }
                            content = parsed.choices?.[0]?.message?.content || '';
                            console.log('=== ErrAnalyst LLM 完整返回 ===');
                            console.log(content);
                            console.log('=== End ===');
                            finish({ content, success: true });
                        }
                        catch (e) {
                            finish({ content: '', success: false, error: `JSON parse error: ${e}` });
                        }
                    });
                    return;
                }
                // Streaming (OpenAI-compatible SSE): each data line is a chat.completion.chunk.
                let buffer = '';
                let raw = '';
                let streamError = null;
                res.on('data', (chunk) => {
                    const text = chunk.toString();
                    raw += text;
                    buffer += text;
                    let nl;
                    while ((nl = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, nl).trim();
                        buffer = buffer.slice(nl + 1);
                        if (!line.startsWith('data:'))
                            continue;
                        const data = line.slice(5).trim();
                        if (!data || data === '[DONE]')
                            continue;
                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        }
                        catch {
                            continue;
                        }
                        if (parsed.error) {
                            streamError = parsed.error.message || 'AI 请求失败';
                            continue;
                        }
                        const choice = parsed.choices?.[0];
                        const delta = choice?.delta?.content ?? choice?.message?.content;
                        if (typeof delta === 'string' && delta.length > 0) {
                            content += delta;
                            onChunk?.(delta);
                        }
                    }
                });
                res.on('error', (e) => {
                    finish({ content, success: false, error: `Stream failed: ${e.message}` });
                });
                res.on('end', () => {
                    if (streamError) {
                        finish({ content, success: false, error: streamError });
                        return;
                    }
                    // Fallback: some providers ignore stream:true and return a plain
                    // JSON body instead of SSE lines.
                    if (!content && raw.trim()) {
                        try {
                            const parsed = JSON.parse(raw);
                            content = parsed.choices?.[0]?.message?.content || '';
                            if (content)
                                onChunk?.(content);
                        }
                        catch {
                            // keep empty content; the caller reports the raw failure below
                        }
                    }
                    console.log('=== ErrAnalyst LLM 完整返回 ===');
                    console.log(content);
                    console.log('=== End ===');
                    finish({ content, success: true });
                });
            });
            if (signal) {
                const onAbort = () => {
                    req.destroy();
                    finish({ content, success: false, aborted: true });
                };
                if (signal.aborted) {
                    onAbort();
                }
                else {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            }
            req.on('error', (e) => {
                finish({ content: '', success: false, error: `Request failed: ${e.message}` });
            });
            req.on('timeout', () => {
                req.destroy();
                finish({ content, success: false, error: 'Request timeout' });
            });
            req.write(body);
            req.end();
        });
    }
}
exports.OpenAICompatibleProvider = OpenAICompatibleProvider;
/**
 * 默认非思考模式：按厂商/模型返回关闭思考所需的额外请求参数。
 *
 * 只有「混合思考模型」（可在思考/非思考间切换）才注入参数：
 * - DeepSeek（deepseek-v4-flash/pro 等）：thinking 默认开启，需显式
 *   {"thinking":{"type":"disabled"}} 关闭。
 * - Kimi/Moonshot：仅 kimi-k2.6 / kimi-k2.5 支持关闭；kimi-k2.7-code、
 *   kimi-k3 等纯思考模型传 disabled 会直接 400，故不传。
 * - Qwen（DashScope 兼容模式）：{"enable_thinking":false} 关闭混合思考。
 * - 自定义/未知提供商：不注入厂商私有参数，避免 OpenAI 等严格端点
 *   因未知字段报错；其默认行为由提供商自身决定。
 */
function buildNonThinkingParams(config) {
    const url = config.baseUrl.toLowerCase();
    const model = config.model.toLowerCase();
    // DeepSeek：思考模式默认开启，必须显式关闭。
    if (config.name === 'DeepSeek' || url.includes('deepseek')) {
        return { thinking: { type: 'disabled' } };
    }
    // Kimi/Moonshot：仅混合思考模型（k2.6 / k2.5）可关闭。
    if (config.name === 'Kimi (Moonshot)' || url.includes('moonshot')) {
        const hybrid = model === 'kimi-k2.6' || model === 'kimi-k2.5'
            || /[-_.]?k2\.[56]([-_.]|$)/.test(model);
        return hybrid ? { thinking: { type: 'disabled' } } : undefined;
    }
    // Qwen（DashScope 兼容模式）：enable_thinking=false 关闭混合思考。
    if (config.name === 'Qwen (通义千问)' || url.includes('dashscope') || url.includes('aliyuncs')) {
        return { enable_thinking: false };
    }
    return undefined;
}
// ── Prompt construction ──
function buildAnalysisPrompts(traceback, category, context, memoryBlock, sourceMeta) {
    const categoryVal = category || 'UNKNOWN';
    return {
        systemPrompt: buildSystemPrompt(categoryVal),
        userPrompt: buildUserPrompt(traceback, categoryVal, context, memoryBlock, sourceMeta),
    };
}
function buildSystemPrompt(category) {
    const roleText = category === 'UNKNOWN'
        ? '你是通用 Python 错误分析专家。根据终端输出和项目配置文件推断错误根因。'
        : '你是 Python 错误分析专家。精通 Python 异常处理、调试和修复。';
    return `你是 ErrAnalyst 错误分析助手。分类：${category}。${roleText}
输出 JSON 格式，字段：
- errorType: string（原始错误类型，与输入一致）
- errorMessage: string（原始错误消息，与输入一致）
- translation: string（中文翻译：自然、专业、流畅；可翻译的技术概念必须译成中文，如 embedding → 向量嵌入；无法翻译的专有名词保留原文并紧跟括号简释，如 OptionalError（可选值错误）；禁止使用 {{keyword}} 标记）
- keywords: [{cn: string, en: string}]（核心报错术语，最多 3 个，可为空数组；只收能指认本报错主题的词或短语，专有名词/标识符出现即收，领域概念词仅在与根因直接相关且翻译有增量时收，普通英文词如 status code 不收）
- analysis: string（中文根因分析，必须引用具体行号，格式为 "文件:行号"）
- fixSuggestion: string（中文修复建议，纯文字描述，不需要代码；必须点名问题文件、给出“文件:行号”引用和分步操作；如果根因在代码之外（环境、服务、配置未就绪等），说明外部原因并给出用户操作步骤）
${category === 'UNKNOWN' ? '- category: string（你判断的错误类别，可选值：COMPILATION_ERROR/DEPENDENCY_ERROR/SYSTEM_ERROR/RUNTIME_ERROR/UNKNOWN）\n' : ''}
常见错误类型译名参考（翻译正文与核心报错术语必须使用这些译名）：
${Object.entries(errorTerms_1.ERROR_TERM_TRANSLATIONS).map(([en, cn]) => `${en} → ${cn}`).join('\n')}
注意：只返回 JSON，不要包含其他文字。`;
}
function buildUserPrompt(traceback, category, context, memoryBlock, sourceMeta) {
    const lines = [];
    const fullTraceback = traceback.fullTraceback || '';
    const stackFrames = traceback.stackFrames || [];
    const chain = traceback.chain || [];
    // ═══ Part 1: 原始 traceback 全文（兜底保障） ═══
    lines.push('## Original Traceback');
    lines.push('');
    lines.push('```');
    lines.push(fullTraceback);
    lines.push('```');
    lines.push('');
    // ═══ Part 2: 结构化报错数据（从 parser 提取，可能为空） ═══
    lines.push('## Parsed Error Data');
    lines.push('');
    if (traceback.errorType) {
        lines.push('Type: ' + traceback.errorType);
    }
    if (traceback.errorMessage) {
        lines.push('Message: ' + traceback.errorMessage);
    }
    if (traceback.filePath) {
        lines.push('File: ' + traceback.filePath + ':' + traceback.lineNumber);
    }
    lines.push('');
    if (stackFrames.length > 0) {
        lines.push('Stack frames:');
        for (const frame of stackFrames.slice(0, 15)) {
            const code = frame.codeLine ? '  -> ' + frame.codeLine : '';
            lines.push('  ' + frame.file + ':' + frame.line + ' in ' + frame.function + code);
        }
        lines.push('');
    }
    if (chain.length > 0) {
        lines.push('Error chain (cause -> ... -> primary):');
        for (const entry of chain) {
            const rel = entry.relationship === 'cause' ? 'cause' : 'context';
            lines.push('  [' + rel + '] ' + entry.filePath + ':' + entry.lineNumber + ' -- ' + entry.errorType + ': ' + entry.errorMessage.slice(0, 100));
            for (const frame of (entry.stackFrames || []).slice(0, 5)) {
                const code = frame.codeLine ? '  -> ' + frame.codeLine : '';
                lines.push('    ' + frame.file + ':' + frame.line + ' in ' + frame.function + code);
            }
        }
        lines.push('  [primary] ' + traceback.filePath + ':' + traceback.lineNumber + ' -- ' + traceback.errorType + ': ' + traceback.errorMessage.slice(0, 100));
        lines.push('');
    }
    // ═══ Part 2.5: 捕获上下文（触发来源与识别档位） ═══
    if (sourceMeta?.triggerSource || sourceMeta?.recognitionTier) {
        lines.push('## Capture Context');
        lines.push('');
        if (sourceMeta.triggerSource === 'runtime') {
            lines.push('触发来源：运行时报错——该报错在服务进程运行期间从终端输出流中捕获，进程可能仍在运行，无退出码语义。请按"服务运行中排查"的角度分析，并说明该错误是否会中断服务。');
        }
        else if (sourceMeta.triggerSource === 'command-end') {
            lines.push('触发来源：命令结束报错——命令以非零状态退出。');
        }
        if (sourceMeta.recognitionTier === 'log-line') {
            lines.push('识别档位：运行日志报错——该报错来自 ERROR/CRITICAL/FATAL 级日志行，无 Traceback 栈帧与文件定位；请结合日志内容与源代码上下文推断根因，若信息不足以定位请明确说明。');
        }
        lines.push('');
    }
    // ═══ Part 3: 源代码上下文（contextBuilder 按优先级挑选的） ═══
    lines.push('## Source Context');
    lines.push('');
    const hasContext = (context?.runningFile || context?.mainFile || context?.stackFiles?.length || context?.configFiles?.length || context?.siblingFiles?.length || context?.guessedFiles?.length);
    if (hasContext) {
        if (context.runningFile) {
            const isErrorFile = context.runningFile.path === traceback.filePath;
            lines.push('### ' + context.runningFile.path + ':' + context.runningFile.startLine + '-' + context.runningFile.endLine + ' (运行文件, full, P0' + (isErrorFile ? ', error location' : '') + ')');
            lines.push('```');
            lines.push(context.runningFile.content);
            lines.push('```');
            lines.push('');
        }
        if (context.mainFile) {
            lines.push('### ' + context.mainFile.path + ':' + context.mainFile.startLine + '-' + context.mainFile.endLine + ' (error location, P0)');
            lines.push('```');
            lines.push(context.mainFile.content);
            lines.push('```');
            lines.push('');
        }
        for (const f of (context.stackFiles || []).slice(0, 5)) {
            lines.push('### ' + f.path + ':' + f.startLine + '-' + f.endLine + ' (stack frame)');
            lines.push('```');
            lines.push(f.content);
            lines.push('```');
            lines.push('');
        }
        for (const f of (context.guessedFiles || []).slice(0, 3)) {
            lines.push('### ' + f.path + ':' + f.startLine + '-' + f.endLine + ' (guessed, 未在调用栈中确认)');
            lines.push('```');
            lines.push(f.content);
            lines.push('```');
            lines.push('');
        }
        for (const f of (context.configFiles || []).slice(0, 2)) {
            lines.push('### ' + f.path + ':' + f.startLine + '-' + f.endLine + ' (config)');
            lines.push('```');
            lines.push(f.content);
            lines.push('```');
            lines.push('');
        }
        for (const f of (context.siblingFiles || []).slice(0, 1)) {
            lines.push('### ' + f.path + ':' + f.startLine + '-' + f.endLine + ' (sibling)');
            lines.push('```');
            lines.push(f.content);
            lines.push('```');
            lines.push('');
        }
    }
    else {
        lines.push('_（contextBuilder 未找到任何相关源代码）_');
        lines.push('');
    }
    // ═══ Part 3.5: 用户长期记忆（偏好 + 常犯错误） ═══
    if (memoryBlock) {
        lines.push(memoryBlock);
        lines.push('');
    }
    // ═══ Part 4: 分析指令 ═══
    lines.push('## Instructions');
    lines.push('');
    lines.push('Analyze the Python error above and provide:');
    lines.push('');
    lines.push('1. translation: Natural, professional, fluent Chinese translation of the error message. Translatable technical concepts MUST be translated into Chinese (e.g., embedding -> 向量嵌入). Proper nouns that cannot be translated (exception names, API/library/model names, paths, commands, config keys) keep the original text and MUST be followed immediately by a parenthetical short explanation (e.g., OptionalError（可选值错误）). Do NOT use {{keyword}} markers.');
    lines.push('2. keywords: Core error terms for this error, 0-3 items, each {cn, en}. Include identifiers/proper nouns that appear in the traceback (exception types, class/function names, API/library/framework/model names). Include a domain concept word (e.g., embedding) only when it is directly tied to the root cause AND its Chinese explanation adds real value. Exclude generic English words/phrases (e.g., status code, connection, value). Put the most meaningful term first (usually the exception type).');
    lines.push('3. analysis: Root cause analysis in Chinese, MUST reference specific file:line numbers from the Source Context or Parsed Error Data');
    lines.push('4. fixSuggestion: Fix suggestion in Chinese, text description only, no code; must name the problem file, cite "file:line" references, and give step-by-step actions; if the root cause is outside the code (environment/service/config not ready), explain the external cause and give operational steps only');
    if (category === 'UNKNOWN') {
        lines.push('5. category: Your best guess for the error category');
    }
    lines.push('');
    lines.push('Return JSON only.');
    lines.push('');
    lines.push('IMPORTANT: Base your analysis primarily on the traceback above. If the Parsed Error Data is incomplete, use the full Original Traceback.');
    return lines.join('\n');
}
const MAX_CORE_TERMS = 3;
/**
 * Mechanical guard for the "core error term" rule: cap at 3, resolve the
 * authoritative dictionary translation, dedupe case-insensitively, drop
 * terms that cannot be traced back to the original error text, and drop
 * terms without a valid Chinese translation.
 */
function sanitizeKeywords(keywords, sourceText) {
    if (!Array.isArray(keywords))
        return [];
    const source = sourceText ? sourceText.toLowerCase() : '';
    const seen = new Set();
    const result = [];
    for (const raw of keywords) {
        if (result.length >= MAX_CORE_TERMS)
            break;
        if (!raw || typeof raw !== 'object')
            continue;
        const en = typeof raw.en === 'string' ? raw.en.trim() : '';
        const cn = typeof raw.cn === 'string' ? raw.cn.trim() : '';
        if (!en)
            continue;
        const key = en.toLowerCase();
        if (seen.has(key))
            continue;
        if (source && !source.includes(key))
            continue;
        const resolvedCn = (0, errorTerms_1.resolveCoreTerm)(en, cn);
        if (!resolvedCn)
            continue;
        seen.add(key);
        result.push({ cn: resolvedCn, en });
    }
    return result;
}
function parseAiResponse(content, sourceText) {
    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return null;
        const data = JSON.parse(jsonMatch[0]);
        return {
            errorType: data.errorType || '',
            errorMessage: data.errorMessage || '',
            translation: data.translation || '',
            keywords: sanitizeKeywords(data.keywords, sourceText),
            analysis: data.analysis || '',
            fixSuggestion: data.fixSuggestion || '',
            category: data.category,
        };
    }
    catch (e) {
        console.error('ErrAnalyst: Failed to parse AI response', e);
        return null;
    }
}
//# sourceMappingURL=openaiCompatible.js.map