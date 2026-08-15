import * as assert from 'assert';
import {
  buildPresetRejectionMessage,
  getActiveModels,
  getDeprecationInfo,
  getModelStatus,
  getPresetModelList,
  getPresetProviders,
  getRecommendedModel,
  isValidModel,
} from '../src/shared/model-catalog';

suite('ModelCatalog', () => {
  test('preset providers come from the catalog with recommended models', () => {
    const providers = getPresetProviders();
    assert.deepStrictEqual(
      providers.map(p => p.name),
      ['DeepSeek', 'Kimi (Moonshot)', 'Qwen (通义千问)']
    );
    assert.strictEqual(getRecommendedModel('DeepSeek'), 'deepseek-v4-flash');
    assert.strictEqual(getRecommendedModel('Kimi (Moonshot)'), 'kimi-k2.7-code-highspeed');
    assert.strictEqual(getRecommendedModel('Qwen (通义千问)'), 'qwen3.7-flash');
  });

  test('active model lists exclude deprecated models', () => {
    const deepseekActive = getActiveModels('DeepSeek').map(m => m.id);
    assert.deepStrictEqual(deepseekActive, ['deepseek-v4-flash', 'deepseek-v4-pro']);
    const deepseekAll = getPresetModelList('DeepSeek').map(m => m.id);
    assert.ok(deepseekAll.includes('deepseek-chat'));
  });

  test('model status: valid / deprecated / unknown', () => {
    assert.strictEqual(getModelStatus('DeepSeek', 'deepseek-v4-flash'), 'valid');
    assert.strictEqual(getModelStatus('DeepSeek', 'deepseek-chat'), 'deprecated');
    assert.strictEqual(getModelStatus('DeepSeek', 'gpt-4o'), 'unknown');
    assert.ok(isValidModel('DeepSeek', 'deepseek-v4-flash'));
    assert.ok(!isValidModel('DeepSeek', 'deepseek-chat'));
    assert.ok(!isValidModel('DeepSeek', 'gpt-4o'));
  });

  test('deprecated models expose migration target', () => {
    assert.deepStrictEqual(getDeprecationInfo('DeepSeek', 'deepseek-chat'), {
      deprecatedAt: '2026-07-24',
      migrateTo: 'deepseek-v4-flash',
    });
    assert.strictEqual(getDeprecationInfo('DeepSeek', 'deepseek-v4-flash'), null);
  });

  test('rejection message lists official models and guides to custom provider', () => {
    const msg = buildPresetRejectionMessage('DeepSeek', 'gpt-4o');
    assert.ok(msg.includes('不在 DeepSeek 官方模型列表'));
    assert.ok(msg.includes('自定义提供商'));
    assert.ok(msg.includes('deepseek-v4-flash'));
  });
});
