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
    async getActiveProvider() {
        const providers = this.getProviders();
        const activeName = vscode.workspace.getConfiguration('errAnalyst')
            .get('activeProvider', '');
        for (const p of providers) {
            if (p.name === activeName && p.enabled) {
                const apiKey = await this.secrets?.get(`errAnalyst:apiKey:${p.name}`);
                if (apiKey) {
                    return { ...p, apiKey };
                }
            }
        }
        return undefined;
    }
    async saveProviderConfig(provider, apiKey, prefs) {
        const config = vscode.workspace.getConfiguration('errAnalyst');
        if (this.secrets) {
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
        await config.update('activeProvider', provider.name, vscode.ConfigurationTarget.Global);
        await config.update('autoAnalyze', prefs.autoAnalyze, vscode.ConfigurationTarget.Global);
        await config.update('enableCache', prefs.enableCache, vscode.ConfigurationTarget.Global);
    }
    getAutoAnalyze() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('autoAnalyze', true);
    }
    getEnableCache() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('enableCache', true);
    }
    getAiTimeout() {
        return vscode.workspace.getConfiguration('errAnalyst')
            .get('aiTimeout', 15000);
    }
}
exports.Config = Config;
//# sourceMappingURL=config.js.map