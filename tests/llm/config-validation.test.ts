import { describe, it, expect } from 'vitest';
import { validateRouterConfig, type ModelRouterConfig } from '../../src/llm/model-router.js';

function validConfig(): ModelRouterConfig {
  return {
    models: {
      'fast-moe': {
        name: 'Test MoE',
        ggufFilename: 'test-moe.gguf',
        provider: 'local',
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        architecture: 'moe',
        speed: 'fast',
      },
    },
    routing: { plan: 'fast-moe', implement: 'fast-moe', review: 'fast-moe' },
  };
}

describe('validateRouterConfig', () => {
  it('accepts a valid config and returns it unchanged', () => {
    const cfg = validConfig();
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toBe(cfg); // same object, not a stripped copy
  });

  it('preserves unmodelled extra fields on success (non-strict)', () => {
    const cfg = validConfig() as any;
    cfg.models['fast-moe'].futureField = 'keep me';
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.config.models['fast-moe'] as any).futureField).toBe('keep me');
  });

  it('rejects a routing target not defined in models, naming the target + available keys', () => {
    const cfg = validConfig();
    cfg.routing.implement = 'qwen-27b-fp8';
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("routing.implement → 'qwen-27b-fp8'");
      expect(result.errors[0]).toContain('not defined in models');
      expect(result.errors[0]).toContain('fast-moe'); // lists what IS available
    }
  });

  it('rejects a typo\'d routing key', () => {
    const cfg = validConfig() as any;
    cfg.routing.implment = 'fast-moe'; // typo for "implement"
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes("routing key 'implment'"))).toBe(true);
      expect(result.errors.some(e => e.includes('not a valid task type'))).toBe(true);
    }
  });

  it('rejects a missing required profile field with a path-tagged message', () => {
    const cfg = validConfig() as any;
    delete cfg.models['fast-moe'].contextWindow;
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.includes('models.fast-moe.contextWindow'))).toBe(true);
  });

  it('rejects a wrong-typed profile field', () => {
    const cfg = validConfig() as any;
    cfg.models['fast-moe'].contextWindow = '200000'; // string, not number
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.includes('models.fast-moe.contextWindow'))).toBe(true);
  });

  it('rejects an invalid enum value (provider)', () => {
    const cfg = validConfig() as any;
    cfg.models['fast-moe'].provider = 'huggingface';
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.includes('models.fast-moe.provider'))).toBe(true);
  });

  it('tags messages with a custom source label', () => {
    const cfg = validConfig();
    cfg.routing.review = 'nope';
    const result = validateRouterConfig(cfg, '~/.config/tdd-workflow/models.config.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('~/.config/tdd-workflow/models.config.json');
  });

  it('reports multiple routing errors at once', () => {
    const cfg = validConfig() as any;
    cfg.routing.implement = 'missing-a';
    cfg.routing.review = 'missing-b';
    const result = validateRouterConfig(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
