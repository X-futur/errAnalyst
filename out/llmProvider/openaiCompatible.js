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
function buildAnalysisPrompts(result) {
    const systemPrompt = `You are a Python error analysis expert. Analyze the Python error and return JSON.

Return ONLY valid JSON (no markdown code block markers):

{
  "errorType": "original error type",
  "errorMessage": "original error message",
  "translation": "Chinese translation, wrap key terms with {{keyword}} markers",
  "keywords": [{"cn": "Chinese term", "en": "English term"}],
  "analysis": "Root cause analysis in Chinese",
  "fixSuggestion": "Fix suggestion in Chinese",
  "fixCode": "Fixed code snippet if applicable"
}

Rules:
1. Use {{keyword}} in translation for highlightable terms
2. Each {{keyword}} must have a matching entry in keywords array
3. Provide detailed, accurate analysis`;
    let contextCode = '';
    for (const frame of result.stackFrames) {
        if (frame.codeLine) {
            contextCode += `File "${frame.file}", line ${frame.line}, in ${frame.function}\n  ${frame.codeLine}\n`;
        }
        else {
            contextCode += `File "${frame.file}", line ${frame.line}, in ${frame.function}\n`;
        }
    }
    const userPrompt = `Error:
${result.fullTraceback}

Stack context:
${contextCode || '(no context code)'}

Analyze this error and return JSON.`;
    return { systemPrompt, userPrompt };
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
            fixCode: data.fixCode || ''
        };
    }
    catch (e) {
        console.error('ErrAnalyst: Failed to parse AI response', e);
        return null;
    }
}
//# sourceMappingURL=openaiCompatible.js.map