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
exports.Config = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const presets_1 = require("./presets");
class Config {
    static getInstance() {
        if (!Config.instance) {
            Config.instance = new Config();
        }
        return Config.instance;
    }
    init(secrets) {
        this.secrets = secrets;
    }
    getProviders() {
        const config = vscode.workspace.getConfiguration('errAnalyst');
        const providers = config.get('providers', []);
        return providers;
    }
    /** 配置向导所需的现有配置：提供商列表 + 各 Key 是否存在（真实 Key 不下发到 webview）。 */
    async getWizardConfig() {
        const providers = this.getProviders();
        const existence = await this.getApiKeyExistence(providers.map(p => p.name));
        return {
            activeProvider: vscode.workspace.getConfiguration('errAnalyst')
                .get('activeProvider', null),
            providers: providers.map(p => ({
                name: p.name,
                baseUrl: p.baseUrl,
                model: p.model,
                hasApiKey: !!existence[p.name],
            })),
            enableCache: this.getEnableCache(),
        };
    }
    /** 读取某个提供商的真实 API Key（SecretStorage 优先，回退 CLI 凭据文件）；仅后端使用，不下发 webview。 */
    async getApiKey(name) {
        const key = await this.secrets?.get(`errAnalyst:apiKey:${name}`);
        if (key)
            return key;
        return this.readCredentialsFile()[name] || undefined;
    }
    async getApiKeyExistence(names) {
        const creds = this.readCredentialsFile();
        const result = {};
        for (const name of names) {
            const key = (await this.secrets?.get(`errAnalyst:apiKey:${name}`)) || creds[name];
            result[name] = !!key;
        }
        return result;
    }
    async getActiveProvider() {
        const providers = this.getProviders();
        const activeName = vscode.workspace.getConfiguration('errAnalyst')
            .get('activeProvider', '');
        for (const p of providers) {
            if (p.name === activeName && p.enabled) {
                const apiKey = await this.getApiKey(p.name);
                if (apiKey) {
                    return { ...p, apiKey };
                }
            }
        }
        return undefined;
    }
    async saveProviderConfig(provider, apiKey, prefs, activeProvider) {
        const config = vscode.workspace.getConfiguration('errAnalyst');
        // 仅在用户输入了新 Key 时覆盖；null/空字符串表示保留原 Key。
        if (this.secrets && apiKey) {
            await this.secrets.store(`errAnalyst:apiKey:${provider.name}`, apiKey);
        }
        let providers = config.get('providers', []);
        const existingIdx = providers.findIndex(p => p.name === provider.name);
        const entry = {
            name: provider.name,
            baseUrl: provider.baseUrl,
            model: provider.model,
            apiKey: '',
            enabled: true,
        };
        if (existingIdx >= 0) {
            providers[existingIdx] = { ...providers[existingIdx], ...entry };
        }
        else {
            providers.push(entry);
        }
        await config.update('providers', providers, vscode.ConfigurationTarget.Global);
        await config.update('activeProvider', activeProvider, vscode.ConfigurationTarget.Global);
        await config.update('enableCache', prefs.enableCache, vscode.ConfigurationTarget.Global);
        // Sync API key to ~/.errAnalyst/credentials.json for CLI access
        if (apiKey) {
            this.writeCredentialsEntry(provider.name, apiKey);
        }
    }
    /** 批量保存自定义提供商：保留预置提供商，更新/新增/删除自定义条目，并处理各自 Key。 */
    async saveCustomProviders(entries, activeProvider, prefs) {
        const config = vscode.workspace.getConfiguration('errAnalyst');
        // '自定义' 只是向导卡片名，不是真实提供商名。
        const presetNames = new Set(presets_1.PRESET_PROVIDERS.filter(p => p.name !== '自定义').map(p => p.name));
        const providers = config.get('providers', []);
        const entriesByName = new Map(entries.map(e => [e.name, e]));
        const nextProviders = [];
        for (const p of providers) {
            if (presetNames.has(p.name)) {
                nextProviders.push(p);
                continue;
            }
            const entry = entriesByName.get(p.name);
            if (entry) {
                nextProviders.push({
                    name: entry.name,
                    baseUrl: entry.baseUrl,
                    model: entry.model,
                    apiKey: '',
                    enabled: p.enabled,
                });
            }
        }
        const existingNames = new Set(nextProviders.map(p => p.name));
        for (const entry of entries) {
            if (!existingNames.has(entry.name)) {
                nextProviders.push({
                    name: entry.name,
                    baseUrl: entry.baseUrl,
                    model: entry.model,
                    apiKey: '',
                    enabled: true,
                });
                existingNames.add(entry.name);
            }
        }
        await config.update('providers', nextProviders, vscode.ConfigurationTarget.Global);
        // 1) 写入新 Key；改名未输入新 Key 时迁移旧 Key；2) 删除被移除条目的 Key。
        const beforeNames = new Set(providers.filter(p => !presetNames.has(p.name)).map(p => p.name));
        const afterNames = new Set(entries.map(e => e.name));
        for (const entry of entries) {
            const oldName = entry.originalName && entry.originalName !== entry.name
                ? entry.originalName
                : undefined;
            if (entry.apiKey) {
                await this.secrets?.store(`errAnalyst:apiKey:${entry.name}`, entry.apiKey);
                this.writeCredentialsEntry(entry.name, entry.apiKey);
                if (oldName) {
                    await this.secrets?.delete(`errAnalyst:apiKey:${oldName}`);
                    this.deleteCredentialsEntry(oldName);
                }
            }
            else if (oldName) {
                const key = await this.getApiKey(oldName);
                if (key) {
                    await this.secrets?.store(`errAnalyst:apiKey:${entry.name}`, key);
                    this.writeCredentialsEntry(entry.name, key);
                }
            }
        }
        for (const removed of beforeNames) {
            if (!afterNames.has(removed)) {
                await this.secrets?.delete(`errAnalyst:apiKey:${removed}`);
                this.deleteCredentialsEntry(removed);
            }
        }
        // 激活提供商回退：被删除的激活项不存在时，落到剩余第一个提供商。
        const finalNames = nextProviders.map(p => p.name);
        const nextActive = finalNames.includes(activeProvider)
            ? activeProvider
            : (finalNames[0] || '');
        await config.update('activeProvider', nextActive, vscode.ConfigurationTarget.Global);
        await config.update('enableCache', prefs.enableCache, vscode.ConfigurationTarget.Global);
    }
    getEnableCache() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('enableCache', true);
    }
    getAiTimeout() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('aiTimeout', 50000);
    }
    getEnableOneClickFix() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('enableOneClickFix', true);
    }
    getEnableChat() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('enableChat', true);
    }
    getMemoryEnabled() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('memory.enabled', true);
    }
    readCredentialsFile() {
        try {
            const credFile = path.join(os.homedir(), '.errAnalyst', 'credentials.json');
            if (fs.existsSync(credFile)) {
                return JSON.parse(fs.readFileSync(credFile, 'utf-8'));
            }
        }
        catch { }
        return {};
    }
    writeCredentialsEntry(name, apiKey) {
        try {
            const credDir = path.join(os.homedir(), '.errAnalyst');
            const credFile = path.join(credDir, 'credentials.json');
            if (!fs.existsSync(credDir))
                fs.mkdirSync(credDir, { recursive: true });
            const creds = this.readCredentialsFile();
            creds[name] = apiKey;
            fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
        }
        catch (e) {
            console.error('ErrAnalyst: Failed to write credentials file for CLI:', e);
        }
    }
    deleteCredentialsEntry(name) {
        try {
            const credFile = path.join(os.homedir(), '.errAnalyst', 'credentials.json');
            const creds = this.readCredentialsFile();
            if (name in creds) {
                delete creds[name];
                fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
            }
        }
        catch (e) {
            console.error('ErrAnalyst: Failed to update credentials file for CLI:', e);
        }
    }
}
exports.Config = Config;
//# sourceMappingURL=config.js.map