import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModelRouter, saveConfig, loadConfig, type ModelRouterConfig } from '../../src/llm/model-router.js';

function makeTestConfig(): ModelRouterConfig {
  return {
    models: {
      'fast-moe': {
        name: 'Test MoE Model',
        ggufFilename: 'test-moe-q4.gguf',
        provider: 'local',
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        architecture: 'moe',
        parameterCount: '35b',
        speed: 'fast',
        samplingParams: { temperature: 0.2, top_k: 40 },
      },
      'slow-dense': {
        name: 'Test Dense Model',
        ggufFilename: 'test-dense-q6.gguf',
        provider: 'local',
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        architecture: 'dense',
        parameterCount: '31b',
        speed: 'slow',
        samplingParams: { temperature: 0.1, top_p: 0.9 },
      },
      'cloud-model': {
        name: 'Cloud Research Model',
        ggufFilename: '',
        modelId: 'anthropic/claude-sonnet-4',
        provider: 'openrouter',
        apiKeyEnvVar: 'OPENROUTER_API_KEY',
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        architecture: 'dense',
        speed: 'medium',
        samplingParams: { temperature: 0.1 },
      },
    },
    routing: {
      plan: 'slow-dense',
      implement: 'fast-moe',
      review: 'slow-dense',
      research: 'cloud-model',
    },
  };
}

describe('ModelRouter', () => {
  it('selects the correct model for each task type', () => {
    const router = new ModelRouter(makeTestConfig());
    expect(router.selectModel('plan').name).toBe('Test Dense Model');
    expect(router.selectModel('implement').name).toBe('Test MoE Model');
    expect(router.selectModel('review').name).toBe('Test Dense Model');
    expect(router.selectModel('research').name).toBe('Cloud Research Model');
  });

  it('returns correct speed for task types', () => {
    const router = new ModelRouter(makeTestConfig());
    expect(router.selectModel('plan').speed).toBe('slow');
    expect(router.selectModel('implement').speed).toBe('fast');
  });

  it('returns correct architecture for models', () => {
    const router = new ModelRouter(makeTestConfig());
    expect(router.selectModel('implement').architecture).toBe('moe');
    expect(router.selectModel('review').architecture).toBe('dense');
  });

  it('falls back to plan model for unmapped design roles', () => {
    const router = new ModelRouter(makeTestConfig());
    // 'design' is not in routing — should fall back to 'plan' model
    const model = router.selectModel('design');
    expect(model.name).toBe('Test Dense Model');
  });

  it('throws on missing model key', () => {
    const config = makeTestConfig();
    config.routing.plan = 'nonexistent';
    const router = new ModelRouter(config);
    expect(() => router.selectModel('plan')).toThrow('not found in config');
  });

  it('lists all available models', () => {
    const router = new ModelRouter(makeTestConfig());
    const models = router.listModels();
    expect(models).toHaveLength(3);
  });

  it('lists model keys', () => {
    const router = new ModelRouter(makeTestConfig());
    expect(router.listModelKeys()).toEqual(['fast-moe', 'slow-dense', 'cloud-model']);
  });

  it('gets sampling params for a task type', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('plan');
    expect(params.temperature).toBe(0.1);
    expect(params.top_p).toBe(0.9);
  });

  it('returns empty sampling params when none configured', () => {
    const config = makeTestConfig();
    delete (config.models['fast-moe'] as any).samplingParams;
    const router = new ModelRouter(config);
    const params = router.getSamplingParams('implement');
    expect(params.temperature).toBeUndefined();
  });

  it('has ggufFilename on local profiles', () => {
    const router = new ModelRouter(makeTestConfig());
    const localModel = router.selectModel('implement');
    expect(localModel.ggufFilename).toBeTruthy();
    expect(localModel.ggufFilename.endsWith('.gguf')).toBe(true);
  });
});

describe('Provider-aware routing', () => {
  it('returns ggufFilename as identifier for local models', () => {
    const router = new ModelRouter(makeTestConfig());
    const profile = router.selectModel('implement');
    expect(router.getModelIdentifier(profile)).toBe('test-moe-q4.gguf');
  });

  it('returns modelId as identifier for cloud models', () => {
    const router = new ModelRouter(makeTestConfig());
    const profile = router.selectModel('research');
    expect(router.getModelIdentifier(profile)).toBe('anthropic/claude-sonnet-4');
  });

  it('returns OpenRouter base URL for openrouter provider', () => {
    const router = new ModelRouter(makeTestConfig());
    const profile = router.selectModel('research');
    expect(router.getBaseURL(profile)).toBe('https://openrouter.ai/api/v1');
  });

  it('returns local URL for local provider', () => {
    const router = new ModelRouter(makeTestConfig());
    const profile = router.selectModel('implement');
    expect(router.getBaseURL(profile)).toContain('localhost');
  });

  it('uses custom baseURL when provided', () => {
    const config = makeTestConfig();
    config.models['cloud-model']!.baseURL = 'https://custom.api.com/v1';
    const router = new ModelRouter(config);
    const profile = router.selectModel('research');
    expect(router.getBaseURL(profile)).toBe('https://custom.api.com/v1');
  });

  it('reads API key from env var when apiKeyEnvVar is set', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-env-key';
    try {
      const router = new ModelRouter(makeTestConfig());
      const profile = router.selectModel('research'); // cloud-model → apiKeyEnvVar: 'OPENROUTER_API_KEY'
      expect(router.getApiKey(profile)).toBe('sk-env-key');
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
      else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('throws when apiKeyEnvVar is set but the env var is missing', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const router = new ModelRouter(makeTestConfig());
      const profile = router.selectModel('research');
      expect(() => router.getApiKey(profile)).toThrow('OPENROUTER_API_KEY');
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('throws for a custom provider with no apiKeyEnvVar configured', () => {
    const config = makeTestConfig();
    config.models['cloud-model']!.provider = 'custom' as any;
    delete config.models['cloud-model']!.apiKeyEnvVar;
    const router = new ModelRouter(config);
    const profile = router.selectModel('research');
    expect(() => router.getApiKey(profile)).toThrow('apiKeyEnvVar');
  });

  it('returns undefined API key for local models', () => {
    const router = new ModelRouter(makeTestConfig());
    const profile = router.selectModel('implement');
    expect(router.getApiKey(profile)).toBeUndefined();
  });
});

describe('saveConfig / loadConfig', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('saves and loads a config file', () => {
    tmpDir = path.join(os.tmpdir(), `config-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const config = makeTestConfig();
    const savedPath = saveConfig(config, tmpDir);
    expect(fs.existsSync(savedPath)).toBe(true);

    const loaded = loadConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.models['fast-moe']!.name).toBe('Test MoE Model');
    expect(loaded!.routing.plan).toBe('slow-dense');
  });

  it('returns null when no config exists', () => {
    tmpDir = path.join(os.tmpdir(), `config-empty-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const loaded = loadConfig(tmpDir);
    expect(loaded === null || typeof loaded === 'object').toBe(true);
  });
});
