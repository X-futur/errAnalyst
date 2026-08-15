import * as assert from 'assert';
import { buildNonThinkingParams } from '../src/llmProvider/openaiCompatible';

function cfg(name: string, baseUrl: string, model: string) {
  return { name, baseUrl, model };
}

suite('buildNonThinkingParams', () => {
  test('DeepSeek: forces thinking disabled', () => {
    assert.deepStrictEqual(
      buildNonThinkingParams(cfg('DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-flash')),
      { thinking: { type: 'disabled' } },
    );
  });

  test('DeepSeek detected via baseUrl for custom names', () => {
    assert.deepStrictEqual(
      buildNonThinkingParams(cfg('My Provider', 'https://api.deepseek.com/v1', 'deepseek-v4-pro')),
      { thinking: { type: 'disabled' } },
    );
  });

  test('Kimi hybrid models (k2.6/k2.5) disable thinking', () => {
    for (const model of ['kimi-k2.6', 'kimi-k2.5']) {
      assert.deepStrictEqual(
        buildNonThinkingParams(cfg('Kimi (Moonshot)', 'https://api.moonshot.cn/v1', model)),
        { thinking: { type: 'disabled' } },
        model,
      );
    }
  });

  test('Kimi thinking-only models do not send thinking params (avoid 400)', () => {
    for (const model of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3']) {
      assert.strictEqual(
        buildNonThinkingParams(cfg('Kimi (Moonshot)', 'https://api.moonshot.cn/v1', model)),
        undefined,
        model,
      );
    }
  });

  test('Qwen: enable_thinking=false', () => {
    assert.deepStrictEqual(
      buildNonThinkingParams(cfg('Qwen (通义千问)', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-flash')),
      { enable_thinking: false },
    );
  });

  test('Unknown provider: no vendor-private params injected', () => {
    assert.strictEqual(
      buildNonThinkingParams(cfg('自定义', 'https://example.com/v1', 'some-model')),
      undefined,
    );
  });
});
