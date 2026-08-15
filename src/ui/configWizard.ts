import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { Config, WizardExistingConfig } from '../config';
import { validateCustomModel } from '../shared/model-validation';

export class ConfigWizard {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private existingConfig?: WizardExistingConfig;

  show(existingConfig?: WizardExistingConfig): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, true);
      return;
    }

    this.existingConfig = existingConfig;

    this.panel = vscode.window.createWebviewPanel(
      'errAnalyst.configWizard',
      'ErrAnalyst - 配置向导',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = this.getHtmlTemplate();

    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.panel = null;
      })
    );

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (msg) => {
        await this.handleMessage(msg);
      })
    );

    // Send init data once webview is ready
    setTimeout(() => {
      if (this.panel) {
        this.panel.webview.postMessage({
          type: 'init',
          data: existingConfig || {
            activeProvider: null,
            providers: [],
            enableCache: true,
            presets: [],
          },
        });
      }
    }, 200);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Webview is ready; init data already sent via setTimeout
        break;
      case 'testConnection':
        await this.handleTestConnection(msg.data);
        break;
      case 'save':
        await this.handleSave(msg.data);
        break;
      case 'close':
        this.dispose();
        break;
    }
  }

  private async handleTestConnection(data: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    apiKey: string;
  }): Promise<void> {
    // 用户未输入新 Key 时，用已保存的 Key 测试（真实 Key 不出 webview）。
    let apiKey = data.apiKey || '';
    if (!apiKey && data.name) {
      apiKey = (await Config.getInstance().getApiKey(data.name)) || '';
    }
    const result = await this.testConnection(data.baseUrl, data.model, apiKey);
    this.panel?.webview.postMessage({ type: 'testResult', data: { id: data.id, ...result } });
  }

  private async handleSave(data:
    | {
        kind: 'preset';
        provider: { name: string; baseUrl: string; model: string };
        apiKey: string | null;
        activeProvider: string;
        enableCache: boolean;
      }
    | {
        kind: 'custom';
        providers: Array<{ name: string; baseUrl: string; model: string; apiKey: string | null }>;
        activeProvider: string;
        enableCache: boolean;
      }
  ): Promise<void> {
    try {
      if (data.kind === 'preset') {
        // 预置提供商：模型来自官方列表下拉，写入即合法。
        await Config.getInstance().saveProviderConfig(
          data.provider,
          data.apiKey || null,
          { enableCache: data.enableCache },
          data.activeProvider
        );
      } else {
        // 自定义提供商：逐条抓取官方模型列表校验，失败回退连接测试。
        const validated: Array<{
          name: string;
          baseUrl: string;
          model: string;
          apiKey: string | null;
          originalName?: string;
          modelStatus?: 'official' | 'unofficial' | 'unverified';
        }> = [];
        const unofficial: string[] = [];
        let hardError: string | null = null;
        for (const entry of data.providers) {
          let apiKey = entry.apiKey || '';
          if (!apiKey && entry.name) {
            apiKey = (await Config.getInstance().getApiKey(entry.name)) || '';
          }
          if (!apiKey) {
            hardError = `${entry.name || '未命名提供商'}: 缺少 API Key，无法校验模型`;
            break;
          }
          const result = await validateCustomModel(entry.baseUrl, entry.model, apiKey);
          if (!result.ok) {
            hardError = `${entry.name || '未命名提供商'}: ${result.error}`;
            break;
          }
          if (result.status === 'unofficial') unofficial.push(entry.name);
          validated.push({ ...entry, modelStatus: result.status });
        }
        if (hardError) {
          this.panel?.webview.postMessage({ type: 'saveError', data: { error: hardError } });
          return;
        }
        if (unofficial.length > 0) {
          const confirm = await vscode.window.showWarningMessage(
            `以下提供商的模型不在官方模型列表：${unofficial.join('、')}。仍要保存？将标记为非官方模型。`,
            { modal: true },
            '仍要保存'
          );
          if (confirm !== '仍要保存') {
            this.panel?.webview.postMessage({
              type: 'saveError',
              data: { error: '已取消保存：部分模型不在官方模型列表' },
            });
            return;
          }
        }
        await Config.getInstance().saveCustomProviders(
          validated,
          data.activeProvider,
          { enableCache: data.enableCache }
        );
      }
      this.panel?.webview.postMessage({ type: 'saved' });
    } catch (e: any) {
      this.panel?.webview.postMessage({
        type: 'saveError',
        data: { error: `保存失败: ${e.message}` },
      });
    }
  }

  private async testConnection(
    baseUrl: string,
    model: string,
    apiKey: string
  ): Promise<{ success: boolean; error?: string }> {
    const sanitized = baseUrl.replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(`${sanitized}/chat/completions`);
    } catch {
      return { success: false, error: 'Base URL 格式无效' };
    }

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1,
    });

    return new Promise((resolve) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      };

      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.message?.content !== undefined) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: 'API 返回格式异常，缺少 choices[0].message.content' });
              }
            } catch {
              resolve({ success: false, error: `响应解析失败: ${data.slice(0, 200)}` });
            }
          } else {
            let errMsg = `HTTP ${res.statusCode}`;
            try {
              const parsed = JSON.parse(data);
              errMsg += `: ${parsed.error?.message || parsed.error || data.slice(0, 200)}`;
            } catch {
              errMsg += `: ${data.slice(0, 200)}`;
            }
            resolve({ success: false, error: errMsg });
          }
        });
      });

      req.on('error', (e) => resolve({ success: false, error: `请求失败: ${e.message}` }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: '连接超时（10 秒）' });
      });
      req.write(body);
      req.end();
    });
  }

  private getHtmlTemplate(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--bg:#1e1e1e;--bg-card:#252526;--bg-input:#3c3c3c;--text:#d4d4d4;--text-muted:#808080;--text-bright:#e0e0e0;--accent:#007acc;--accent-hover:#1a8ad4;--border:#3c3c3c;--error:#f44747;--success:#4ec9b0;--step-done:#4ec9b0;--step-active:#007acc;--step-inactive:#3c3c3c;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:20px;font-size:13px;line-height:1.5}
.step-indicator{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:24px;padding:12px 0}
.step-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--step-inactive);color:var(--text-muted);transition:all .2s}
.step-dot.active{background:var(--step-active);color:#fff}
.step-dot.done{background:var(--step-done);color:#fff}
.step-line{width:60px;height:2px;background:var(--step-inactive);transition:background .2s}
.step-line.done{background:var(--step-done)}
.step-label{font-size:11px;text-align:center;color:var(--text-muted);margin-top:4px}
.step-label.active{color:var(--text-bright)}
.step-indicator-col{display:flex;flex-direction:column;align-items:center}
.step-content{display:none}
.step-content.active{display:block}
h2{font-size:16px;margin-bottom:16px;color:var(--text-bright)}
h3{font-size:13px;font-weight:600;margin-bottom:12px;color:var(--text-bright)}
.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px}
.provider-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:12px;cursor:pointer;transition:all .15s}
.provider-card:hover{border-color:var(--accent);background:rgba(0,122,204,.08)}
.provider-card.selected{border-color:var(--accent);background:rgba(0,122,204,.15)}
.provider-card .card-icon{font-size:20px;margin-bottom:6px}
.provider-card .card-name{font-weight:600;font-size:13px;margin-bottom:2px}
.provider-card .card-desc{font-size:11px;color:var(--text-muted)}
.card-badge{display:inline-block;font-size:10px;padding:1px 7px;border-radius:8px;margin-top:6px;font-weight:600}
.card-badge.configured{background:rgba(78,201,176,.15);color:var(--success)}
.card-badge.active{background:rgba(0,122,204,.22);color:#75b8f0}
.card-active-btn{margin-top:8px;width:100%;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);padding:4px 8px;font-size:11px;cursor:pointer;transition:all .15s}
.card-active-btn:hover{border-color:var(--accent);color:#fff}
.card-active-btn.active{background:rgba(0,122,204,.18);border-color:var(--accent);color:#75b8f0;cursor:default}
.form-section{background:var(--bg-card);border-radius:6px;padding:16px;margin-bottom:16px}
.field{margin-bottom:12px}
.field:last-child{margin-bottom:0}
.field label{display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)}
.field .required{color:var(--error)}
.field input{width:100%;padding:6px 10px;font-size:13px;font-family:Consolas,Monaco,monospace;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);outline:none;transition:border-color .15s}
.field input:focus{border-color:var(--accent)}
.field input:disabled{opacity:.5;cursor:not-allowed}
.field select{width:100%;padding:6px 10px;font-size:13px;font-family:Consolas,Monaco,monospace;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);outline:none;cursor:pointer}
.field select:focus{border-color:var(--accent)}
.field select:disabled{opacity:.5;cursor:not-allowed}
.input-with-button{display:flex;gap:6px}
.input-with-button input{flex:1}
.input-with-button button{padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer;font-size:14px;transition:background .15s}
.input-with-button button:hover{background:var(--accent)}
.input-with-button button.icon-btn{width:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.input-with-button button.icon-btn svg{display:block}
.field-error{color:var(--error);font-size:11px;margin-top:4px;display:none}
.field-hint{color:var(--text-muted);font-size:11px;margin-top:4px}
.test-row{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
.test-btn{background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:5px 14px;font-size:12px;cursor:pointer;transition:background .15s}
.test-btn:hover:not(:disabled){border-color:var(--accent);color:#fff}
.test-btn:disabled{opacity:.45;cursor:not-allowed}
.test-result{font-size:12px;display:none}
.test-result.success{display:block;color:var(--success)}
.test-result.failure{display:block;color:var(--error)}
.test-result .test-detail{margin-top:2px;font-size:11px;opacity:.8}
.custom-section h3{margin-bottom:4px}
.custom-hint{font-size:11px;color:var(--text-muted);margin-bottom:14px}
.custom-entries{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.custom-entry{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:14px 16px;transition:border-color .15s}
.custom-entry.active{border-color:var(--accent)}
.entry-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.entry-title{flex:1;font-size:12px;font-weight:600;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.entry-active-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer;white-space:nowrap}
.entry-active-label input{accent-color:var(--accent);cursor:pointer}
.entry-remove{background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);padding:3px 10px;font-size:11px;cursor:pointer;transition:all .15s}
.entry-remove:hover{border-color:var(--error);color:var(--error)}
.entry-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.entry-grid .field{margin-bottom:0}
.entry-grid .field.full{grid-column:1 / -1}
.add-entry-btn{width:100%;padding:10px;background:transparent;border:1px dashed var(--border);border-radius:6px;color:var(--text-muted);font-size:12px;cursor:pointer;transition:all .15s}
.add-entry-btn:hover{border-color:var(--accent);color:var(--accent)}
.nav-bar{display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.btn{padding:8px 20px;border:none;border-radius:4px;font-size:13px;cursor:pointer;transition:background .15s}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed}
.btn-secondary{background:var(--bg-input);color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:#4a4a4a}
.toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);background:var(--bg-input);color:var(--text-bright);border:1px solid var(--accent);border-radius:6px;padding:8px 16px;font-size:13px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s}
.toast.show{opacity:1}
.spinner{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.pref-section{background:var(--bg-card);border-radius:6px;padding:16px;margin-bottom:16px}
.toggle-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-row .toggle-label{font-size:13px}
.toggle-row .toggle-desc{font-size:11px;color:var(--text-muted)}
.toggle{width:40px;height:20px;background:var(--bg-input);border-radius:10px;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0}
.toggle.on{background:var(--accent)}
.toggle .toggle-thumb{width:16px;height:16px;background:#fff;border-radius:50%;position:absolute;top:2px;left:2px;transition:left .2s}
.toggle.on .toggle-thumb{left:22px}
.summary-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:16px}
.summary-row{display:flex;padding:4px 0;font-size:12px}
.summary-row .summary-key{width:100px;color:var(--text-muted);flex-shrink:0}
.summary-row .summary-val{color:var(--text)}
.summary-row .summary-val.yes{color:var(--success)}
.summary-row .summary-val.no{color:var(--text-muted)}
</style>
</head>
<body>

<div class="step-indicator">
  <div class="step-indicator-col">
    <div class="step-dot active" id="dot-1">1</div>
    <div class="step-label active" id="label-1">选择提供商</div>
  </div>
  <div class="step-line" id="line-1"></div>
  <div class="step-indicator-col">
    <div class="step-dot" id="dot-2">2</div>
    <div class="step-label" id="label-2">偏好与保存</div>
  </div>
</div>

<!-- Step 1 -->
<div class="step-content active" id="step-1">
  <h2>选择 AI 提供商</h2>
  <div class="card-grid" id="provider-cards"></div>

  <div class="form-section" id="preset-form" style="display:none">
    <h3>填写凭据</h3>
    <div class="field">
      <label>API Key <span class="required">*</span></label>
      <div class="input-with-button">
        <input type="password" id="api-key-input" placeholder="sk-..." autocomplete="off" />
        <button id="toggle-key-btn" type="button" class="icon-btn" title="显示 API Key"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
      </div>
      <div class="field-error" id="key-error">请填入 API Key</div>
      <div class="field-hint" id="key-hint"></div>
    </div>
    <div class="field">
      <label>Model <span class="field-hint" id="model-hint">(官方模型列表，推荐置顶)</span></label>
      <select id="model-input"></select>
      <div class="field-error" id="model-error">请选择官方模型列表内的模型</div>
    </div>
    <div class="field">
      <label>Base URL</label>
      <input type="text" id="url-display-input" disabled />
    </div>
    <div class="test-row">
      <button class="test-btn" id="preset-test-btn">测试连接</button>
      <div class="test-result" id="preset-test-result"></div>
    </div>
  </div>

  <div class="custom-section" id="custom-section" style="display:none">
    <h3>自定义提供商</h3>
    <div class="custom-hint">可配置多个 OpenAI 兼容提供商；每个条目需名称、Base URL、Model 与 API Key，点“设为当前使用”指定激活项。</div>
    <div class="custom-entries" id="custom-entries"></div>
    <button class="add-entry-btn" id="add-entry-btn">＋ 添加自定义提供商</button>
  </div>
</div>

<!-- Step 2 -->
<div class="step-content" id="step-2">
  <h2>偏好设置</h2>
  <div class="pref-section">
    <h3>全局设置</h3>
    <div class="toggle-row">
      <div>
        <div class="toggle-label">保存错误历史</div>
        <div class="toggle-desc">把报错分析结果保存到本地缓存，仅作历史查阅，不参与自动分析</div>
      </div>
      <div class="toggle on" id="toggle-enableCache" data-key="enableCache"><div class="toggle-thumb"></div></div>
    </div>
  </div>
  <div class="summary-card" id="summary-card">
    <h3>配置摘要</h3>
    <div id="summary-content"></div>
  </div>
</div>

<!-- Navigation -->
<div class="nav-bar">
  <button class="btn btn-secondary" id="prev-btn" style="display:none">&larr; 上一步</button>
  <div></div>
  <button class="btn btn-primary" id="next-btn">下一步 &rarr;</button>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const MASK = '●●●●●●●●';
  // 预置提供商与官方模型列表由后端下发（与快照单一来源），此处仅声明变量。
  var PRESETS = [];
  var PRESET_NAMES = [];

  const state = {
    step: 1,
    card: null,
    presets: [],
    customs: [],
    activeProvider: null,
    activeChoice: null,
    enableCache: true,
    presetApiKey: '',
    presetModel: '',
    seq: 1,
    saving: false,
    autoTesting: false,
    batchFailures: [],
    pendingTests: [],
  };

  const $ = id => document.getElementById(id);
  const EYE_OFF_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  const EYE_ON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  var toastTimer = null;
  function showToast(msg) {
    var el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { el.classList.remove('show'); }, 2500);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escAttr(s) { return esc(s).replace(/'/g, '&#39;'); }

  function findPreset(name) {
    for (var i = 0; i < state.presets.length; i++) {
      if (state.presets[i].name === name) return state.presets[i];
    }
    return null;
  }
  function findCustom(id) {
    for (var i = 0; i < state.customs.length; i++) {
      if (state.customs[i].id === id) return state.customs[i];
    }
    return null;
  }
  function countCustomConfigured() {
    var n = 0;
    for (var i = 0; i < state.customs.length; i++) {
      var c = state.customs[i];
      if (c.hasKey || c.apiKey) n++;
    }
    return n;
  }

  function presetBadgeHtml(p) {
    if (p.isActive) return '<span class="card-badge active">当前使用</span>';
    if (p.hasKey) return '<span class="card-badge configured">已配置</span>';
    return '';
  }

  function renderCards() {
    var container = $('provider-cards');
    container.innerHTML = '';
    PRESETS.forEach(function(p) {
      var card = document.createElement('div');
      card.className = 'provider-card' + (state.card === p.name ? ' selected' : '');
      card.dataset.name = p.name;
      var badge = '';
      if (p.name === '自定义') {
        var activeCustom = null;
        for (var i = 0; i < state.customs.length; i++) if (state.customs[i].isActive) activeCustom = state.customs[i];
        var n = countCustomConfigured();
        if (activeCustom) badge = '<span class="card-badge active">当前使用</span>';
        else if (n > 0) badge = '<span class="card-badge configured">' + n + ' 个已配置</span>';
      } else {
        var preset = findPreset(p.name);
        if (preset) badge = presetBadgeHtml(preset);
      }
      var actBtn = '';
      if (p.name !== '自定义') {
        var presetObj = findPreset(p.name);
        actBtn = presetObj && presetObj.isActive
          ? '<button class="card-active-btn active" type="button">✓ 当前使用</button>'
          : '<button class="card-active-btn" type="button">设为当前使用</button>';
      }
      card.innerHTML = '<div class="card-icon">' + p.icon + '</div><div class="card-name">' + esc(p.name) + '</div><div class="card-desc">' + esc(p.desc) + '</div>' + badge + actBtn;
      var actBtnEl = card.querySelector('.card-active-btn');
      if (actBtnEl) {
        actBtnEl.addEventListener('click', function(e) {
          e.stopPropagation();
          markActive(p.name);
        });
      }
      card.addEventListener('click', function() { selectCard(p.name); });
      container.appendChild(card);
    });
  }

  function markActive(name) {
    state.activeChoice = name;
    state.presets.forEach(function(p) { p.isActive = p.name === name; });
    state.customs.forEach(function(c) { c.isActive = c.name === name; });
    renderCards();
    updateSummary();
  }

  function selectCard(name) {
    if (state.autoTesting) return;
    state.card = name;
    var isCustom = name === '自定义';
    document.querySelectorAll('.provider-card').forEach(function(c) {
      c.classList.toggle('selected', c.dataset.name === name);
    });
    $('preset-form').style.display = isCustom ? 'none' : 'block';
    $('custom-section').style.display = isCustom ? 'block' : 'none';
    if (isCustom) {
      renderCustomEntries();
    } else {
      fillPresetForm(name);
    }
  }

  function fillPresetForm(name) {
    var p = findPreset(name);
    if (!p) return;
    var catalog = PRESETS.filter(function(x) { return x.name === name; })[0];
    if (!catalog) return;
    state.presetApiKey = '';
    var keyInput = $('api-key-input');
    keyInput.value = '';
    keyInput.type = 'password';
    keyInput.placeholder = p.hasKey ? MASK : 'sk-...';
    $('toggle-key-btn').innerHTML = EYE_ON_SVG;
    $('toggle-key-btn').title = '显示 API Key';
    $('url-display-input').value = p.baseUrl;
    $('model-hint').textContent = '(官方模型列表，推荐置顶)';
    $('key-hint').textContent = p.hasKey ? '(已配置，留空保持不变)' : '';
    $('key-error').style.display = 'none';
    $('preset-test-result').style.display = 'none';
    $('preset-test-result').className = 'test-result';

    // 模型下拉：推荐模型置顶；当前模型无效/已下线时显示占位提示并要求重选。
    var select = $('model-input');
    select.innerHTML = '';
    var activeModels = (catalog.models || []).filter(function(m) { return !m.deprecated; });
    var currentValid = activeModels.some(function(m) { return m.id === p.model; });
    var currentStatus = p.presetModelStatus;
    if (!currentValid) {
      var ph = document.createElement('option');
      ph.value = '';
      ph.disabled = true;
      ph.selected = true;
      ph.textContent = p.model
        ? '（当前模型 ' + p.model + (currentStatus === 'deprecated' ? ' 已下线/即将下线' : ' 不在官方列表') + '，请重新选择）'
        : '（请选择模型）';
      select.appendChild(ph);
    }
    activeModels.slice().sort(function(a, b) {
      return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
    }).forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      var tierText = m.tier === 'fast' ? ' · ⚡ 快速' : m.tier === 'balanced' ? ' · 均衡' : ' · 更强';
      opt.textContent = (m.recommended ? '⚡ 推荐 · ' : '') + m.id + tierText + (m.id === p.model ? '（当前）' : '');
      if (m.id === p.model) opt.selected = true;
      select.appendChild(opt);
    });
    // 当前模型无效时必须显式重选，不静默替换为推荐模型。
    state.presetModel = currentValid ? select.value : '';
    $('model-error').style.display = currentValid ? 'none' : 'block';
  }

  $('api-key-input').addEventListener('input', function() {
    state.presetApiKey = this.value;
    $('key-error').style.display = 'none';
  });
  $('model-input').addEventListener('change', function() {
    state.presetModel = this.value;
    $('model-error').style.display = 'none';
  });
  $('toggle-key-btn').addEventListener('click', function() {
    var input = $('api-key-input');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    this.innerHTML = show ? EYE_OFF_SVG : EYE_ON_SVG;
    this.title = show ? '隐藏 API Key' : '显示 API Key';
  });

  function renderCustomEntries() {
    var container = $('custom-entries');
    container.innerHTML = '';
    state.customs.forEach(function(c, idx) {
      var el = document.createElement('div');
      el.className = 'custom-entry' + (c.isActive ? ' active' : '');
      var keyPlaceholder = c.hasKey ? 'placeholder="' + MASK + '"' : 'placeholder="sk-..."';
      var keyHint = c.hasKey ? '<div class="field-hint">(已配置，留空保持不变)</div>' : '';
      var resultHtml = '';
      if (c.result) {
        resultHtml = c.result.success
          ? '<div class="test-result success">✅ 连接成功</div>'
          : '<div class="test-result failure">❌ ' + esc(c.result.error || '连接失败') + '</div>';
      } else if (c.testing) {
        resultHtml = '<span class="spinner"></span><span style="color:var(--text-muted);font-size:12px">测试中...</span>';
      }
      var statusHtml = '';
      if (c.modelStatus === 'official') {
        statusHtml = '<div class="field-hint" style="color:var(--success)">✓ 官方模型</div>';
      } else if (c.modelStatus === 'unofficial') {
        statusHtml = '<div class="field-hint" style="color:#e8a33d">⚠ 非官方模型</div>';
      } else if (c.modelStatus === 'unverified') {
        statusHtml = '<div class="field-hint" style="color:#e8a33d">⚠ 未通过官方列表校验</div>';
      }
      el.innerHTML =
        '<div class="entry-head">' +
          '<div class="entry-title">' + esc(c.name || ('自定义提供商 ' + (idx + 1))) + '</div>' +
          '<label class="entry-active-label"><input type="radio" name="custom-active" data-idx="' + idx + '"' + (c.isActive ? ' checked' : '') + ' />设为当前使用</label>' +
          '<button class="entry-remove" data-idx="' + idx + '">删除</button>' +
        '</div>' +
        '<div class="entry-grid">' +
          '<div class="field"><label>名称 <span class="required">*</span></label><input type="text" class="ce-name" data-idx="' + idx + '" value="' + escAttr(c.name) + '" placeholder="MyAI" /></div>' +
          '<div class="field"><label>Base URL <span class="required">*</span></label><input type="text" class="ce-url" data-idx="' + idx + '" value="' + escAttr(c.baseUrl) + '" placeholder="https://api.example.com/v1" /></div>' +
          '<div class="field full"><label>Model <span class="required">*</span></label><input type="text" class="ce-model" data-idx="' + idx + '" value="' + escAttr(c.model) + '" placeholder="model-name" />' + statusHtml + '</div>' +
          '<div class="field full"><label>API Key</label><div class="input-with-button">' +
            '<input type="password" class="ce-key" data-idx="' + idx + '" ' + keyPlaceholder + ' autocomplete="off" />' +
            '<button type="button" class="icon-btn ce-eye" data-idx="' + idx + '" title="显示 API Key">' + EYE_ON_SVG + '</button>' +
          '</div>' + keyHint + '</div>' +
        '</div>' +
        '<div class="test-row"><button class="test-btn ce-test" data-idx="' + idx + '">测试连接</button>' + resultHtml + '</div>';
      container.appendChild(el);
    });
  }

  $('custom-entries').addEventListener('input', function(e) {
    var t = e.target;
    var idx = t.dataset ? t.dataset.idx : undefined;
    if (idx === undefined) return;
    var c = state.customs[+idx];
    if (!c) return;
    if (t.classList.contains('ce-name')) {
      c.name = t.value;
      var titles = $('custom-entries').querySelectorAll('.entry-title');
      if (titles[+idx]) titles[+idx].textContent = t.value || ('自定义提供商 ' + (+idx + 1));
    } else if (t.classList.contains('ce-url')) {
      c.baseUrl = t.value;
    } else if (t.classList.contains('ce-model')) {
      c.model = t.value;
    } else if (t.classList.contains('ce-key')) {
      c.apiKey = t.value === MASK ? '' : t.value;
    }
    renderCards();
  });

  $('custom-entries').addEventListener('click', function(e) {
    var t = e.target;
    var idx = t.dataset ? t.dataset.idx : undefined;
    if (idx === undefined) return;
    var c = state.customs[+idx];
    if (!c) return;
    if (t.classList.contains('ce-eye')) {
      var wrap = t.parentElement;
      var input = wrap.querySelector('.ce-key');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      t.innerHTML = show ? EYE_OFF_SVG : EYE_ON_SVG;
      t.title = show ? '隐藏 API Key' : '显示 API Key';
    } else if (t.classList.contains('entry-remove')) {
      if (state.autoTesting) return;
      var wasActive = c.isActive;
      state.customs.splice(+idx, 1);
      if (wasActive) {
        if (state.customs.length > 0) {
          state.customs[0].isActive = true;
          state.activeChoice = state.customs[0].name || null;
          state.presets.forEach(function(p) { p.isActive = false; });
        } else {
          state.activeChoice = null;
        }
      }
      renderCustomEntries();
      renderCards();
    } else if (t.classList.contains('ce-test')) {
      runCustomTest(+idx);
    }
  });

  $('custom-entries').addEventListener('change', function(e) {
    var t = e.target;
    if (t.name !== 'custom-active') return;
    var idx = +t.dataset.idx;
    state.customs.forEach(function(x, i) { x.isActive = (i === idx); });
    state.presets.forEach(function(p) { p.isActive = false; });
    state.activeChoice = state.customs[idx] ? state.customs[idx].name : null;
    document.querySelectorAll('.custom-entry').forEach(function(el, i) {
      el.classList.toggle('active', i === idx);
    });
    renderCards();
    updateSummary();
  });

  $('add-entry-btn').addEventListener('click', function() {
    if (state.autoTesting) return;
    state.customs.push({
      id: 'c' + (state.seq++),
      name: '',
      originalName: '',
      baseUrl: '',
      model: '',
      apiKey: '',
      hasKey: false,
      isActive: state.customs.length === 0,
      testing: false,
      result: null,
    });
    renderCustomEntries();
    renderCards();
  });

  function runCustomTest(idx) {
    if (state.autoTesting) return;
    var c = state.customs[idx];
    if (!c) return;
    if (!c.baseUrl.trim()) { c.result = { success: false, error: '请先填写 Base URL' }; renderCustomEntries(); return; }
    if (!c.model.trim()) { c.result = { success: false, error: '请先填写 Model' }; renderCustomEntries(); return; }
    c.testing = true;
    c.result = null;
    renderCustomEntries();
    vscode.postMessage({ type: 'testConnection', data: {
      id: c.id,
      name: c.name.trim(),
      baseUrl: c.baseUrl.trim(),
      model: c.model.trim(),
      apiKey: c.apiKey,
    } });
  }

  $('preset-test-btn').addEventListener('click', function() {
    if (state.autoTesting) return;
    var p = findPreset(state.card);
    if (!p) return;
    var btn = $('preset-test-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>测试中...';
    $('preset-test-result').className = 'test-result';
    $('preset-test-result').style.display = 'none';
    vscode.postMessage({ type: 'testConnection', data: {
      id: 'preset',
      name: state.card,
      baseUrl: p.baseUrl,
      model: state.presetModel.trim(),
      apiKey: state.presetApiKey,
    } });
  });

  function showPresetTestResult(success, error) {
    var btn = $('preset-test-btn');
    btn.disabled = false;
    btn.innerHTML = '测试连接';
    var el = $('preset-test-result');
    if (success) {
      el.className = 'test-result success';
      el.innerHTML = '✅ 连接成功！API Key 有效';
    } else {
      el.className = 'test-result failure';
      el.innerHTML = '❌ 连接失败<div class="test-detail">' + esc(error || '未知错误') + '</div>';
    }
    el.style.display = 'block';
  }

  function validate() {
    $('key-error').style.display = 'none';
    $('model-error').style.display = 'none';
    if (state.card === '自定义') {
      if (state.customs.length === 0) { showToast('请至少添加一个自定义提供商'); return false; }
      var seen = {};
      for (var i = 0; i < state.customs.length; i++) {
        var c = state.customs[i];
        var n = c.name.trim();
        if (!n) { showToast('第 ' + (i + 1) + ' 个自定义提供商缺少名称'); return false; }
        if (seen[n.toLowerCase()]) { showToast('提供商名称重复: ' + n); return false; }
        seen[n.toLowerCase()] = true;
        if (PRESET_NAMES.indexOf(n) >= 0) { showToast('名称与预置提供商重复: ' + n); return false; }
        if (!c.baseUrl.trim()) { showToast(n + ': 缺少 Base URL'); return false; }
        try { new URL(c.baseUrl.trim()); } catch (e) { showToast(n + ': Base URL 格式无效'); return false; }
        if (!c.model.trim()) { showToast(n + ': 缺少 Model'); return false; }
        if (!c.apiKey.trim() && !c.hasKey) { showToast('请为 ' + n + ' 填写 API Key'); return false; }
      }
      var hasActive = false;
      for (var j = 0; j < state.customs.length; j++) if (state.customs[j].isActive) hasActive = true;
      if (!hasActive) state.customs[0].isActive = true;
      return true;
    }
    var p = findPreset(state.card);
    if (!state.presetApiKey.trim() && !(p && p.hasKey)) {
      $('key-error').style.display = 'block';
      $('api-key-input').focus();
      showToast('请填入 API Key');
      return false;
    }
    if (!state.presetModel.trim()) {
      $('model-error').style.display = 'block';
      $('model-input').focus();
      showToast('请选择官方模型列表内的模型');
      return false;
    }
    return true;
  }

  function goToStep(n) {
    state.step = n;
    document.querySelectorAll('.step-content').forEach(function(el) {
      el.classList.toggle('active', el.id === 'step-' + n);
    });
    for (var i = 1; i <= 2; i++) {
      var dot = $('dot-' + i), label = $('label-' + i);
      dot.className = 'step-dot' + (i === n ? ' active' : i < n ? ' done' : '');
      label.className = 'step-label' + (i === n ? ' active' : '');
      var line = i < 2 ? $('line-' + i) : null;
      if (line) line.className = 'step-line' + (i < n ? ' done' : '');
    }
    $('prev-btn').style.display = n === 1 ? 'none' : 'inline-block';
    var nb = $('next-btn');
    if (n === 2) nb.textContent = '完成配置';
    else nb.textContent = '下一步 →';
  }

  $('prev-btn').addEventListener('click', function() {
    if (state.step > 1 && !state.autoTesting) goToStep(state.step - 1);
  });

  $('next-btn').addEventListener('click', function() {
    if (state.saving || state.autoTesting) return;
    if (state.step === 1) {
      if (!validate()) return;
      runAllTestsAndProceed();
    } else {
      save();
    }
  });

  function runAllTestsAndProceed() {
    state.autoTesting = true;
    state.batchFailures = [];
    var nb = $('next-btn');
    nb.disabled = true;
    nb.textContent = '测试中...';
    if (state.card === '自定义') {
      state.pendingTests = [];
      for (var i = 0; i < state.customs.length; i++) state.pendingTests.push(i);
      runNextCustomTest();
    } else {
      var p = findPreset(state.card);
      vscode.postMessage({ type: 'testConnection', data: {
        id: 'preset',
        name: state.card,
        baseUrl: p.baseUrl,
        model: state.presetModel.trim(),
        apiKey: state.presetApiKey,
      } });
    }
  }

  function runNextCustomTest() {
    if (state.pendingTests.length === 0) {
      finishBatchTest();
      return;
    }
    var idx = state.pendingTests.shift();
    var c = state.customs[idx];
    if (!c) { runNextCustomTest(); return; }
    c.testing = true;
    c.result = null;
    renderCustomEntries();
    vscode.postMessage({ type: 'testConnection', data: {
      id: c.id,
      name: c.name.trim(),
      baseUrl: c.baseUrl.trim(),
      model: c.model.trim(),
      apiKey: c.apiKey,
    } });
  }

  function finishBatchTest() {
    state.autoTesting = false;
    var nb = $('next-btn');
    nb.disabled = false;
    nb.textContent = '下一步 →';
    if (state.batchFailures.length > 0) {
      showToast('有 ' + state.batchFailures.length + ' 个连接测试未通过，请检查后重试');
    } else {
      updateSummary();
      goToStep(2);
    }
  }

  function finishPresetAutoTest(success) {
    state.autoTesting = false;
    var nb = $('next-btn');
    nb.disabled = false;
    nb.textContent = '下一步 →';
    if (!success) {
      showToast('连接测试未通过，请检查后重试');
    } else {
      updateSummary();
      goToStep(2);
    }
  }

  function updateSummary() {
    var activeName = null;
    var activeIcon = '';
    for (var i = 0; i < state.presets.length; i++) {
      if (state.presets[i].isActive) {
        activeName = state.presets[i].name;
        activeIcon = PRESETS[i].icon;
      }
    }
    for (var j = 0; j < state.customs.length; j++) {
      if (state.customs[j].isActive) {
        activeName = state.customs[j].name || '自定义';
        activeIcon = '⚙️';
      }
    }
    var n = countCustomConfigured();
    $('summary-content').innerHTML =
      '<div class="summary-row"><span class="summary-key">激活提供商</span><span class="summary-val">' + esc(activeIcon ? activeIcon + ' ' + activeName : (activeName || '(未设置)')) + '</span></div>' +
      '<div class="summary-row"><span class="summary-key">自定义提供商</span><span class="summary-val">' + n + ' 个已配置</span></div>' +
      '<div class="summary-row"><span class="summary-key">保存历史</span><span class="summary-val ' + (state.enableCache ? 'yes' : 'no') + '">' + (state.enableCache ? '✓ 已开启' : '✗ 已关闭') + '</span></div>';
  }

  function save() {
    state.saving = true;
    var nb = $('next-btn');
    nb.disabled = true;
    nb.textContent = '保存中...';
    if (state.card === '自定义') {
      var activeEntry = null;
      for (var i = 0; i < state.customs.length; i++) if (state.customs[i].isActive) activeEntry = state.customs[i];
      if (!activeEntry) activeEntry = state.customs[0];
      var providers = state.customs.map(function(c) {
        return {
          name: c.name.trim(),
          baseUrl: c.baseUrl.trim(),
          model: c.model.trim(),
          apiKey: c.apiKey.trim() || null,
          originalName: c.originalName || '',
        };
      });
      vscode.postMessage({ type: 'save', data: {
        kind: 'custom',
        providers: providers,
        activeProvider: activeEntry.name.trim(),
        enableCache: state.enableCache,
      } });
    } else {
      var p = findPreset(state.card);
      vscode.postMessage({ type: 'save', data: {
        kind: 'preset',
        provider: { name: state.card, baseUrl: p.baseUrl, model: state.presetModel.trim() },
        apiKey: state.presetApiKey.trim() || null,
        activeProvider: state.activeChoice || state.card,
        enableCache: state.enableCache,
      } });
    }
  }

  document.querySelectorAll('.toggle').forEach(function(el) {
    el.addEventListener('click', function() {
      this.classList.toggle('on');
      state[this.dataset.key] = this.classList.contains('on');
      updateSummary();
    });
  });

  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'init':
        var d = msg.data;
        PRESETS = (d.presets || []).map(function(p) {
          return {
            name: p.name,
            baseUrl: p.baseUrl,
            model: p.recommendedModel,
            icon: p.icon,
            desc: p.description,
            models: p.models || [],
          };
        });
        PRESETS.push({ name: '自定义', baseUrl: '', model: '', icon: '⚙️', desc: '接入任意 OpenAI 兼容 API，可配置多个', models: [] });
        PRESET_NAMES = PRESETS.filter(function(p) { return p.name !== '自定义'; }).map(function(p) { return p.name; });
        state.activeProvider = d.activeProvider || null;
        state.activeChoice = state.activeProvider;
        state.enableCache = d.enableCache !== undefined ? d.enableCache : true;
        var providers = d.providers || [];
        PRESETS.forEach(function(p) {
          if (p.name === '自定义') return;
          var found = null;
          for (var i = 0; i < providers.length; i++) {
            if (providers[i].name === p.name) { found = providers[i]; break; }
          }
          state.presets.push({
            name: p.name,
            baseUrl: found ? (found.baseUrl || p.baseUrl) : p.baseUrl,
            model: found ? (found.model || p.model) : p.model,
            hasKey: !!(found && found.hasApiKey),
            isActive: !!(found && found.name === state.activeProvider),
            presetModelStatus: found ? (found.presetModelStatus || 'valid') : 'valid',
          });
        });
        state.customs = [];
        providers.forEach(function(pr) {
          if (PRESET_NAMES.indexOf(pr.name) >= 0) return;
          state.customs.push({
            id: 'c' + (state.seq++),
            name: pr.name,
            originalName: pr.name,
            baseUrl: pr.baseUrl,
            model: pr.model,
            apiKey: '',
            hasKey: !!pr.hasApiKey,
            isActive: pr.name === state.activeProvider,
            testing: false,
            result: null,
            modelStatus: pr.modelStatus || null,
          });
        });
        if (state.customs.length === 0) {
          state.customs.push({
            id: 'c' + (state.seq++),
            name: '',
            originalName: '',
            baseUrl: '',
            model: '',
            apiKey: '',
            hasKey: false,
            isActive: false,
            testing: false,
            result: null,
            modelStatus: null,
          });
        }
        var selected = null;
        var hasRealCustom = false;
        for (var rc = 0; rc < state.customs.length; rc++) {
          if (state.customs[rc].name) { hasRealCustom = true; break; }
        }
        if (state.activeProvider && PRESET_NAMES.indexOf(state.activeProvider) >= 0) {
          selected = state.activeProvider;
        } else if (state.activeProvider) {
          selected = '自定义';
        } else {
          selected = hasRealCustom ? '自定义' : state.presets[0].name;
        }
        renderCards();
        selectCard(selected);
        $('toggle-enableCache').classList.toggle('on', state.enableCache);
        updateSummary();
        break;
      case 'testResult':
        if (msg.data.id === 'preset') {
          showPresetTestResult(msg.data.success, msg.data.error);
          if (state.autoTesting) finishPresetAutoTest(msg.data.success);
        } else {
          var c = findCustom(msg.data.id);
          if (c) {
            c.testing = false;
            c.result = { success: msg.data.success, error: msg.data.error };
            renderCustomEntries();
            if (state.autoTesting) {
              if (!msg.data.success) state.batchFailures.push(c.name || '未命名提供商');
              runNextCustomTest();
            }
          }
        }
        break;
      case 'saved':
        var sb = $('next-btn');
        sb.disabled = false;
        sb.textContent = '✅ 已保存';
        setTimeout(function() { vscode.postMessage({ type: 'close' }); }, 800);
        break;
      case 'saveError':
        var seBtn = $('next-btn');
        seBtn.disabled = false;
        seBtn.textContent = '完成配置';
        state.saving = false;
        $('summary-card').innerHTML += '<div style="color:var(--error);margin-top:8px;font-size:12px">' + esc(msg.data.error) + '</div>';
        break;
    }
  });
})();
</script>
</body>
</html>`;
  }
}
