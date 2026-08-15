'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 10000;

function request(baseUrl, pathname, apiKey, timeoutMs, method, body) {
  return new Promise((resolve) => {
    const sanitized = String(baseUrl || '').replace(/\/+$/, '');
    let url;
    try {
      url = new URL(`${sanitized}${pathname}`);
    } catch (e) {
      resolve({ ok: false, statusCode: 0, body: '', error: `Base URL 格式无效: ${e.message}` });
      return;
    }
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || ''}`,
      },
      timeout: timeoutMs || DEFAULT_TIMEOUT,
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ ok: true, statusCode: res.statusCode || 0, body: data }));
    });
    req.on('error', (e) => resolve({ ok: false, statusCode: 0, body: '', error: `请求失败: ${e.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: '', error: '连接超时' });
    });
    if (body) req.write(body);
    req.end();
  });
}

/** 抓取 OpenAI 兼容 `/models` 列表。 */
async function fetchModelList(baseUrl, apiKey, timeoutMs) {
  const res = await request(baseUrl, '/models', apiKey, timeoutMs, 'GET', null);
  if (!res.ok || res.statusCode !== 200) {
    let detail = '';
    if (res.body) {
      try {
        const parsed = JSON.parse(res.body);
        detail = parsed.error?.message || parsed.error || '';
      } catch { /* keep raw */ }
    }
    return { ok: false, error: `获取模型列表失败（HTTP ${res.statusCode || '—'}）${detail ? ': ' + detail : ''}` };
  }
  try {
    const parsed = JSON.parse(res.body);
    const models = Array.isArray(parsed.data)
      ? parsed.data.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
      : [];
    if (models.length === 0) {
      return { ok: false, error: '模型列表为空或格式异常' };
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: `模型列表解析失败: ${e.message}` };
  }
}

/** 最小代价连接测试：向 chat/completions 发一条消息。 */
async function testChatConnection(baseUrl, model, apiKey, timeoutMs) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 1,
  });
  const res = await request(baseUrl, '/chat/completions', apiKey, timeoutMs, 'POST', body);
  if (!res.ok) return { ok: false, error: `请求失败: ${res.error || ''}` };
  if (res.statusCode === 200) {
    try {
      const parsed = JSON.parse(res.body);
      if (parsed.choices?.[0]?.message?.content !== undefined) {
        return { ok: true };
      }
      return { ok: false, error: 'API 返回格式异常，缺少 choices[0].message.content' };
    } catch (e) {
      return { ok: false, error: `响应解析失败: ${e.message}` };
    }
  }
  let detail = '';
  if (res.body) {
    try {
      const parsed = JSON.parse(res.body);
      detail = parsed.error?.message || parsed.error || res.body.slice(0, 200);
    } catch {
      detail = res.body.slice(0, 200);
    }
  }
  return { ok: false, error: `连接测试失败（HTTP ${res.statusCode}）${detail ? ': ' + detail : ''}` };
}

/**
 * 自定义提供商模型校验：
 * - 抓取 `/models` 成功且命中 → 'official'
 * - 抓取成功但未命中 → 需连接测试通过，'unofficial'
 * - 抓取失败 → 需连接测试通过，'unverified'
 * 连接测试失败时 ok=false，不能保存。
 */
async function validateCustomModel(baseUrl, model, apiKey, timeoutMs) {
  const fetchResult = await fetchModelList(baseUrl, apiKey, timeoutMs);
  if (fetchResult.ok) {
    const hit = fetchResult.models.some((m) => m === model);
    if (hit) return { ok: true, status: 'official' };
    const conn = await testChatConnection(baseUrl, model, apiKey, timeoutMs);
    if (!conn.ok) {
      return { ok: false, status: 'unofficial', error: `模型不在官方模型列表，且连接测试失败: ${conn.error}` };
    }
    return { ok: true, status: 'unofficial' };
  }
  const conn = await testChatConnection(baseUrl, model, apiKey, timeoutMs);
  if (!conn.ok) {
    return { ok: false, status: 'unverified', error: `无法获取官方模型列表，且连接测试失败: ${conn.error}` };
  }
  return { ok: true, status: 'unverified' };
}

function modelStatusLabel(status) {
  switch (status) {
    case 'official': return '官方模型';
    case 'unofficial': return '非官方模型';
    case 'unverified': return '未通过官方列表校验';
    case 'deprecated': return '已下线/即将下线';
    case 'invalid': return '无效模型（不在官方列表）';
    default: return '未知';
  }
}

module.exports = {
  DEFAULT_TIMEOUT,
  request,
  fetchModelList,
  testChatConnection,
  validateCustomModel,
  modelStatusLabel,
};
