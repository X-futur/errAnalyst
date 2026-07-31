import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { Config } from '../config';
import { PRESET_PROVIDERS, ProviderPreset } from '../presets';

interface ExistingConfig {
  activeProvider: string | null;
  providers: Array<{ name: string; baseUrl: string; model: string; apiKey?: string }>;
  autoAnalyze: boolean;
  apiKey?: string;
		enableCache: boolean;
}

export class ConfigWizard {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private existingConfig?: ExistingConfig;

  show(existingConfig?: ExistingConfig): void {
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
            autoAnalyze: true,
            enableCache: true,
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

  private async handleTestConnection(data: { baseUrl: string; model: string; apiKey: string }): Promise<void> {
    const result = await this.testConnection(data.baseUrl, data.model, data.apiKey);
    this.panel?.webview.postMessage({ type: 'testResult', data: result });
  }

  private async handleSave(data: {
    provider: { name: string; baseUrl: string; model: string };
    apiKey: string;
    autoAnalyze: boolean;
		enableCache: boolean;
  }): Promise<void> {
    try {
      await Config.getInstance().saveProviderConfig(data.provider, data.apiKey, {
        autoAnalyze: data.autoAnalyze,
        enableCache: data.enableCache,
      });
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
    const PRESETS = PRESET_PROVIDERS;
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
.step-line{width:40px;height:2px;background:var(--step-inactive);transition:background .2s}
.step-line.done{background:var(--step-done)}
.step-label{font-size:11px;text-align:center;color:var(--text-muted);margin-top:4px}
.step-label.active{color:var(--text-bright)}
.step-indicator-col{display:flex;flex-direction:column;align-items:center}
.step-content{display:none}
.step-content.active{display:block}
h2{font-size:16px;margin-bottom:16px;color:var(--text-bright)}
.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px}
.provider-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:12px;cursor:pointer;transition:all .15s}
.provider-card:hover{border-color:var(--accent);background:rgba(0,122,204,.08)}
.provider-card.selected{border-color:var(--accent);background:rgba(0,122,204,.15)}
.provider-card .card-icon{font-size:20px;margin-bottom:6px}
.provider-card .card-name{font-weight:600;font-size:13px;margin-bottom:2px}
.provider-card .card-desc{font-size:11px;color:var(--text-muted)}
.form-section{background:var(--bg-card);border-radius:6px;padding:16px;margin-bottom:16px}
.form-section h3{font-size:13px;font-weight:600;margin-bottom:12px;color:var(--text-bright)}
.field{margin-bottom:12px}
.field:last-child{margin-bottom:0}
.field label{display:block;font-size:12px;margin-bottom:4px;color:var(--text-muted)}
.field .required{color:var(--error)}
.field input{width:100%;padding:6px 10px;font-size:13px;font-family:Consolas,Monaco,monospace;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);outline:none;transition:border-color .15s}
.field input:focus{border-color:var(--accent)}
.field input:disabled{opacity:.5;cursor:not-allowed}
.input-with-button{display:flex;gap:6px}
.input-with-button input{flex:1}
.input-with-button button{padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer;font-size:14px;transition:background .15s}
.input-with-button button:hover{background:var(--accent)}
.field-error{color:var(--error);font-size:11px;margin-top:4px;display:none}
.field-hint{color:var(--text-muted);font-size:11px;margin-top:4px}
.nav-bar{display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.btn{padding:8px 20px;border:none;border-radius:4px;font-size:13px;cursor:pointer;transition:background .15s}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed}
.btn-secondary{background:var(--bg-input);color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:#4a4a4a}
.test-card{background:var(--bg-card);border-radius:6px;padding:24px;text-align:center;max-width:400px;margin:0 auto}
.test-card h3{font-size:15px;margin-bottom:8px}
.test-card p{font-size:12px;color:var(--text-muted);margin-bottom:20px}
.test-result{margin-top:16px;padding:10px;border-radius:4px;font-size:12px;display:none}
.test-result.success{display:block;background:rgba(78,201,176,.15);color:var(--success);border:1px solid var(--success)}
.test-result.failure{display:block;background:rgba(244,71,71,.15);color:var(--error);border:1px solid var(--error)}
.test-result .test-detail{margin-top:4px;font-size:11px;opacity:.8}
.skip-link{display:inline-block;margin-top:12px;font-size:12px;color:var(--text-muted);cursor:pointer;text-decoration:underline}
.skip-link:hover{color:var(--accent)}
.btn-testing{pointer-events:none;opacity:.7}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.pref-section{background:var(--bg-card);border-radius:6px;padding:16px;margin-bottom:16px}
.pref-section h3{font-size:13px;font-weight:600;margin-bottom:12px;color:var(--text-bright)}
.toggle-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-row .toggle-label{font-size:13px}
.toggle-row .toggle-desc{font-size:11px;color:var(--text-muted)}
.toggle{width:40px;height:20px;background:var(--bg-input);border-radius:10px;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0}
.toggle.on{background:var(--accent)}
.toggle .toggle-thumb{width:16px;height:16px;background:#fff;border-radius:50%;position:absolute;top:2px;left:2px;transition:left .2s}
.toggle.on .toggle-thumb{left:22px}
.summary-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:16px}
.summary-card h3{font-size:13px;font-weight:600;margin-bottom:12px;color:var(--text-bright)}
.summary-row{display:flex;padding:4px 0;font-size:12px}
.summary-row .summary-key{width:80px;color:var(--text-muted);flex-shrink:0}
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
    <div class="step-label" id="label-2">验证连接</div>
  </div>
  <div class="step-line" id="line-2"></div>
  <div class="step-indicator-col">
    <div class="step-dot" id="dot-3">3</div>
    <div class="step-label" id="label-3">偏好设置</div>
  </div>
</div>

<!-- Step 1 -->
<div class="step-content active" id="step-1">
  <h2>选择 AI 提供商</h2>
  <div class="card-grid" id="provider-cards"></div>
  <div class="form-section">
    <h3>填写凭据</h3>
    <div class="field">
      <label>API Key <span class="required">*</span></label>
      <div class="input-with-button">
        <input type="password" id="api-key-input" placeholder="sk-..." autocomplete="off" />
        <button id="paste-btn" title="粘贴">&#x1F4CB;</button>
      </div>
      <div class="field-error" id="key-error">请输入 API Key</div>
    </div>
    <div class="field">
      <label>Model <span class="field-hint" id="model-hint">(使用默认值)</span></label>
      <input type="text" id="model-input" />
      <div class="field-error" id="model-error">请输入 Model 名称</div>
    </div>
    <div class="field" id="url-field" style="display:none">
      <label>Base URL <span class="required">*</span></label>
      <input type="text" id="url-input" placeholder="https://api.example.com/v1" />
      <div class="field-error" id="url-error">请输入 Base URL</div>
    </div>
    <div class="field" id="url-display">
      <label>Base URL</label>
      <input type="text" id="url-display-input" disabled />
    </div>
  </div>
</div>

<!-- Step 2 -->
<div class="step-content" id="step-2">
  <h2>验证连接</h2>
  <div class="test-card">
    <h3>测试 API 连接</h3>
    <p>确认 API Key 有效，测试通过后自动进入下一步</p>
    <button class="btn btn-primary" id="test-btn">测试连接</button>
    <div class="test-result" id="test-result"></div>
    <div class="skip-link" id="skip-link">跳过测试 &rarr;</div>
  </div>
</div>

<!-- Step 3 -->
<div class="step-content" id="step-3">
  <h2>偏好设置</h2>
  <div class="pref-section">
    <h3>全局设置</h3>
    <div class="toggle-row">
      <div>
        <div class="toggle-label">自动 AI 分析</div>
        <div class="toggle-desc">终端检测到报错时自动调用 AI 分析</div>
      </div>
      <div class="toggle on" id="toggle-autoAnalyze" data-key="autoAnalyze"><div class="toggle-thumb"></div></div>
    </div>
    <div class="toggle-row">
      <div>
        <div class="toggle-label">缓存相同报错</div>
        <div class="toggle-desc">缓存相同报错的分析结果，避免重复请求</div>
      </div>
      <div class="toggle on" id="toggle-enableCache" data-key="enableCache"><div class="toggle-thumb"></div></div>
    </div>
  </div>
  <div class="summary-card">
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
  const state = {
    step: 1, selectedProvider: null, apiKey: '', model: '', baseUrl: '',
    autoAnalyze: true, enableCache: true, testPassed: false, isDirty: false,
    existingProviderName: null, existingApiKey: '',
  };
  const PRESETS = [
    { name: 'DeepSeek',        baseUrl: 'https://api.deepseek.com/v1',                        model: 'deepseek-v4-pro', icon: '\\ud83d\\udd35', desc: '\\u6027\\u4ef7\\u6bd4\\u9ad8\\u7684\\u901a\\u7528\\u6a21\\u578b' },
    { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1',                         model: 'moonshot-v1-8k',  icon: '\\ud83d\\udd34', desc: '\\u957f\\u4e0a\\u4e0b\\u6587\\u63a8\\u7406\\u80fd\\u529b\\u5f3a' },
    { name: 'Qwen (\\u901a\\u4e49\\u5343\\u95ee)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo', icon: '\\ud83d\\udfe0', desc: '\\u963f\\u91cc\\u4e91\\u901a\\u4e49\\u5343\\u95ee\\u5927\\u6a21\\u578b' },
    { name: '\\u81ea\\u5b9a\\u4e49', baseUrl: '', model: '', icon: '\\u2699\\ufe0f', desc: '\\u63a5\\u5165\\u4efb\\u610f OpenAI \\u517c\\u5bb9 API' },
  ];

  const $ = id => document.getElementById(id);

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // Build cards
  const container = $('provider-cards');
  function buildCards() {
    container.innerHTML = '';
    PRESETS.forEach(function(p, i) {
      var card = document.createElement('div');
      card.className = 'provider-card' + (i === 0 ? ' selected' : '');
      card.dataset.name = p.name;
      card.innerHTML = '<div class="card-icon">' + p.icon + '</div><div class="card-name">' + esc(p.name) + '</div><div class="card-desc">' + esc(p.desc) + '</div>';
      card.addEventListener('click', function() { selectProvider(p.name); });
      container.appendChild(card);
    });
  }
  buildCards();

  function selectProvider(name) {
    state.selectedProvider = name;
    state.isDirty = true;
    document.querySelectorAll('.provider-card').forEach(function(c) {
      c.classList.toggle('selected', c.dataset.name === name);
    });
    var preset = PRESETS.find(function(p) { return p.name === name; });
    state.baseUrl = preset ? preset.baseUrl : '';
    state.model = preset ? preset.model : '';
    if (state.existingProviderName === name && state.existingApiKey) {
      state.apiKey = state.existingApiKey;
    } else if (state.existingProviderName !== name) {
      state.apiKey = '';
    }
    updateForm();
  }

  function updateForm() {
    var isCustom = state.selectedProvider === '\\u81ea\\u5b9a\\u4e49';
    $('url-field').style.display = isCustom ? 'block' : 'none';
    $('url-display').style.display = isCustom ? 'none' : 'block';
    $('url-display-input').value = state.baseUrl;
    $('model-input').value = state.model;
    $('api-key-input').value = state.apiKey;
    if (isCustom) {
      $('model-hint').textContent = '(\\u5fc5\\u586b)';
    } else if (state.model) {
      $('model-hint').textContent = '(\\u4f7f\\u7528\\u9ed8\\u8ba4\\u503c\\uff0c\\u53ef\\u4fee\\u6539)';
    }
  }

  $('api-key-input').addEventListener('input', function() { state.apiKey = this.value; state.isDirty = true; $('key-error').style.display = 'none'; });
  $('model-input').addEventListener('input', function() { state.model = this.value; });
  $('url-input').addEventListener('input', function() { state.baseUrl = this.value; });
  $('paste-btn').addEventListener('click', function() {
    navigator.clipboard.readText().then(function(text) {
      $('api-key-input').value = text; state.apiKey = text; state.isDirty = true; $('key-error').style.display = 'none';
    }).catch(function() {});
  });

  var stepLines = { '1-2': $('line-1'), '2-3': $('line-2') };
  function goToStep(n) {
    state.step = n;
    document.querySelectorAll('.step-content').forEach(function(el) { el.classList.toggle('active', el.id === 'step-' + n); });
    for (var i = 1; i <= 3; i++) {
      var dot = $('dot-' + i), label = $('label-' + i);
      dot.className = 'step-dot' + (i === n ? ' active' : i < n ? ' done' : '');
      label.className = 'step-label' + (i === n ? ' active' : '');
      var line = i < 3 ? $('line-' + i) : null;
      if (line) line.className = 'step-line' + (i < n ? ' done' : '');
    }
    $('prev-btn').style.display = n === 1 ? 'none' : 'inline-block';
    var nb = $('next-btn');
    if (n === 3) { nb.textContent = '\\u5b8c\\u6210\\u914d\\u7f6e'; nb.style.display = 'inline-block'; }
    else if (n === 2) { nb.style.display = 'none'; }
    else { nb.textContent = '\\u4e0b\\u4e00\\u6b65 \\u2192'; nb.style.display = 'inline-block'; }
  }

  $('prev-btn').addEventListener('click', function() { if (state.step > 1) goToStep(state.step - 1); });

  $('next-btn').addEventListener('click', function() {
    if (state.step === 1) {
      if (!state.selectedProvider) return;
      if (!state.apiKey.trim()) { $('key-error').style.display = 'block'; return; }
      if (state.selectedProvider === '\\u81ea\\u5b9a\\u4e49' && !state.baseUrl.trim()) { $('url-error').style.display = 'block'; return; }
      $('key-error').style.display = 'none'; $('url-error').style.display = 'none';
      updateSummary();
      goToStep(2);
      runTest();
    } else if (state.step === 2) {
      goToStep(3);
    } else if (state.step === 3) {
      var saveBtn = $('next-btn'); saveBtn.disabled = true; saveBtn.textContent = '\\u4fdd\\u5b58\\u4e2d...';
      vscode.postMessage({ type: 'save', data: {
        provider: { name: state.selectedProvider, baseUrl: state.baseUrl, model: state.model },
        apiKey: state.apiKey, autoAnalyze: state.autoAnalyze, enableCache: state.enableCache
      }});
    }
  });

  $('skip-link').addEventListener('click', function() { goToStep(3); });

  function runTest() {
    $('test-btn').disabled = true;
    $('test-btn').innerHTML = '<span class="spinner"></span>\\u6d4b\\u8bd5\\u4e2d...';
    $('test-btn').className = 'btn btn-primary btn-testing';
    $('test-result').className = 'test-result';
    $('test-result').style.display = 'none';
    vscode.postMessage({ type: 'testConnection', data: { baseUrl: state.baseUrl, model: state.model, apiKey: state.apiKey } });
  }

  $('test-btn').addEventListener('click', runTest);

  document.querySelectorAll('.toggle').forEach(function(el) {
    el.addEventListener('click', function() {
      this.classList.toggle('on');
      state[this.dataset.key] = this.classList.contains('on');
      updateSummary();
    });
  });

  function updateSummary() {
    var preset = PRESETS.find(function(p) { return p.name === state.selectedProvider; });
    var label = preset && preset.icon ? preset.icon + ' ' + state.selectedProvider : state.selectedProvider;
    $('summary-content').innerHTML =
      '<div class="summary-row"><span class="summary-key">\\u63d0\\u4f9b\\u5546</span><span class="summary-val">' + esc(label) + '</span></div>' +
      '<div class="summary-row"><span class="summary-key">\\u6a21\\u578b</span><span class="summary-val">' + esc(state.model || '(\\u672a\\u8bbe\\u7f6e)') + '</span></div>' +
      '<div class="summary-row"><span class="summary-key">\\u81ea\\u52a8\\u5206\\u6790</span><span class="summary-val ' + (state.autoAnalyze ? 'yes' : 'no') + '">' + (state.autoAnalyze ? '\\u2713 \\u5df2\\u5f00\\u542f' : '\\u2717 \\u5df2\\u5173\\u95ed') + '</span></div>' +
      '<div class="summary-row"><span class="summary-key">\\u7f13\\u5b58</span><span class="summary-val ' + (state.enableCache ? 'yes' : 'no') + '">' + (state.enableCache ? '\\u2713 \\u5df2\\u5f00\\u542f' : '\\u2717 \\u5df2\\u5173\\u95ed') + '</span></div>';
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'init':
        var d = msg.data;
        if (d.activeProvider) {
          state.existingProviderName = d.activeProvider;
          var existingPreset = PRESETS.find(function(p) { return p.name === d.activeProvider; });
          if (existingPreset) {
            state.selectedProvider = d.activeProvider;
            state.baseUrl = existingPreset.baseUrl;
            state.model = existingPreset.model;
          } else {
            var ep = (d.providers || []).find(function(p) { return p.name === d.activeProvider; });
            if (ep) { state.selectedProvider = '\\u81ea\\u5b9a\\u4e49'; state.baseUrl = ep.baseUrl; state.model = ep.model; }
          }
          state.existingApiKey = d.apiKey || '';
          state.apiKey = state.existingApiKey ? '\\u25cf\\u25cf\\u25cf\\u25cf\\u25cf\\u25cf\\u25cf\\u25cf' : '';
        }
        if (d.autoAnalyze !== undefined) state.autoAnalyze = d.autoAnalyze;
        if (d.enableCache !== undefined) state.enableCache = d.enableCache;
        if (state.selectedProvider) {
          document.querySelectorAll('.provider-card').forEach(function(c) { c.classList.toggle('selected', c.dataset.name === state.selectedProvider); });
          updateForm();
        }
        $('toggle-autoAnalyze').classList.toggle('on', state.autoAnalyze);
        $('toggle-enableCache').classList.toggle('on', state.enableCache);
        updateSummary();
        break;
      case 'testResult':
        $('test-btn').disabled = false;
        $('test-btn').innerHTML = '\\u6d4b\\u8bd5\\u8fde\\u63a5';
        $('test-btn').className = 'btn btn-primary';
        var r = $('test-result');
        if (msg.data.success) {
          state.testPassed = true;
          r.className = 'test-result success';
          r.innerHTML = '\\u2705 \\u8fde\\u63a5\\u6210\\u529f\\uff01API Key \\u6709\\u6548';
          r.style.display = 'block';
          goToStep(3);
        } else {
          state.testPassed = false;
          r.className = 'test-result failure';
          r.innerHTML = '\\u274c \\u8fde\\u63a5\\u5931\\u8d25<div class="test-detail">' + esc(msg.data.error || '\\u672a\\u77e5\\u9519\\u8bef') + '</div>';
          r.style.display = 'block';
        }
        break;
      case 'saved':
        var sb = $('next-btn'); sb.disabled = false; sb.textContent = '\\u2705 \\u5df2\\u4fdd\\u5b58';
        setTimeout(function() { vscode.postMessage({ type: 'close' }); }, 800);
        break;
      case 'saveError':
        $('next-btn').disabled = false;
        $('next-btn').textContent = '\\u5b8c\\u6210\\u914d\\u7f6e';
        var se = $('summary-card');
        se.innerHTML += '<div style="color:var(--error);margin-top:8px;font-size:12px">' + esc(msg.data.error) + '</div>';
        break;
    }
  });
})();
</script>
</body>
</html>`;
  }
}
