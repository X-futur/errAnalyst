'use strict';

const fs = require('fs');
const path = require('path');

// tsc 不会把 JSON 复制到 out/，扩展运行时用 out/src/shared/model-catalog.js；
// 这里依次回退到源码目录，保证 dev/watch/VSIX 都能找到快照。
function resolveCatalogFile() {
  const candidates = [
    path.join(__dirname, 'model-catalog.json'),
    path.join(__dirname, '..', '..', 'src', 'shared', 'model-catalog.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const CATALOG_FILE = resolveCatalogFile();

let cached = null;

function loadCatalog() {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
  }
  return cached;
}

function getPresetProviders() {
  const catalog = loadCatalog();
  return Object.keys(catalog.providers).map((name) => ({
    name,
    baseUrl: catalog.providers[name].baseUrl,
  }));
}

function getPresetModelList(providerName) {
  const provider = loadCatalog().providers[providerName];
  return provider ? provider.models : [];
}

/** 仅官方可用的模型（排除已下线/即将下线）。 */
function getActiveModels(providerName) {
  return getPresetModelList(providerName).filter((m) => !m.deprecated);
}

/** 预置提供商的推荐模型（速度优先）；无推荐时取第一个可用模型。 */
function getRecommendedModel(providerName) {
  const active = getActiveModels(providerName);
  const recommended = active.find((m) => m.recommended);
  return (recommended || active[0] || {}).id || '';
}

/**
 * 预置提供商模型状态：
 * - 'valid'      官方可用
 * - 'deprecated' 已下线/即将下线（不可用，但提供迁移建议）
 * - 'unknown'    不在官方模型列表
 */
function getModelStatus(providerName, model) {
  const found = getPresetModelList(providerName).find((m) => m.id === model);
  if (!found) return 'unknown';
  return found.deprecated ? 'deprecated' : 'valid';
}

function isValidModel(providerName, model) {
  return getModelStatus(providerName, model) === 'valid';
}

function getDeprecationInfo(providerName, model) {
  const found = getPresetModelList(providerName).find((m) => m.id === model);
  if (!found || !found.deprecated) return null;
  return {
    deprecatedAt: found.deprecatedAt || '',
    migrateTo: found.migrateTo || '',
  };
}

/** 预置提供商写入拒绝文案：点名模型不在官方列表，并引导自定义提供商。 */
function buildPresetRejectionMessage(providerName, model) {
  const list = getActiveModels(providerName)
    .map((m) => (m.recommended ? '⚡ ' : '') + m.id)
    .join('、');
  return `模型 "${model}" 不在 ${providerName} 官方模型列表，可用自定义提供商添加（erranalyst provider set → 自定义）；或选择以下模型：${list}`;
}

module.exports = {
  CATALOG_FILE,
  loadCatalog,
  getPresetProviders,
  getPresetModelList,
  getActiveModels,
  getRecommendedModel,
  getModelStatus,
  isValidModel,
  getDeprecationInfo,
  buildPresetRejectionMessage,
};
