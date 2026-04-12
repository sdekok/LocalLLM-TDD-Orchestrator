import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readPiLlamaCppProviders, readPiCachedModels, readPiCachedModelInfo } from '../../../src/interfaces/pi/pi-models.js';

function makePiAgentDir(homeDir: string) {
  const dir = path.join(homeDir, '.pi', 'agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('readPiLlamaCppProviders', () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('returns empty array when models.json does not exist', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    expect(readPiLlamaCppProviders(tmpHome)).toEqual([]);
  });

  it('returns empty array when models.json is malformed', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'models.json'), 'not json {{{');
    expect(readPiLlamaCppProviders(tmpHome)).toEqual([]);
  });

  it('returns empty array when there are no llamacpp providers', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', apiKey: 'sk-xxx' },
      },
    }));
    expect(readPiLlamaCppProviders(tmpHome)).toEqual([]);
  });

  it('returns a single llamacpp provider', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'llama-cpp': { baseUrl: 'http://localhost:8080/v1', api: 'llamacpp', apiKey: 'none' },
      },
    }));
    const result = readPiLlamaCppProviders(tmpHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: 'llama-cpp', baseUrl: 'http://localhost:8080/v1' });
  });

  it('returns multiple llamacpp providers and ignores non-llamacpp ones', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'llama-local': { baseUrl: 'http://localhost:8080/v1', api: 'llamacpp', apiKey: 'none' },
        'llama-remote': { baseUrl: 'http://server.example.com:8000/v1', api: 'llamacpp', apiKey: 'none' },
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', apiKey: 'sk-xxx' },
      },
    }));
    const result = readPiLlamaCppProviders(tmpHome);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.name)).toEqual(['llama-local', 'llama-remote']);
  });

  it('ignores llamacpp providers that have no baseUrl', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'no-url': { api: 'llamacpp' },
        'with-url': { baseUrl: 'http://localhost:8080/v1', api: 'llamacpp' },
      },
    }));
    const result = readPiLlamaCppProviders(tmpHome);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('with-url');
  });
});

describe('readPiCachedModels', () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('returns empty array when cache file does not exist', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    expect(readPiCachedModels('http://localhost:8080/v1', tmpHome)).toEqual([]);
  });

  it('returns empty array when cache file is malformed', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), 'not json {{{');
    expect(readPiCachedModels('http://localhost:8080/v1', tmpHome)).toEqual([]);
  });

  it('returns empty array when baseUrl is not in cache', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), JSON.stringify({
      'llama-cpp': {
        baseUrl: 'http://other-server:9090/v1',
        models: [{ id: 'some-model' }],
      },
    }));
    expect(readPiCachedModels('http://localhost:8080/v1', tmpHome)).toEqual([]);
  });

  it('returns model IDs for a matching baseUrl', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), JSON.stringify({
      'llama-cpp': {
        baseUrl: 'http://localhost:8080/v1',
        models: [
          { id: 'model-a', contextWindow: 128000, reasoning: false },
          { id: 'model-b', contextWindow: 32000, reasoning: true },
        ],
        savedAt: 1776000000000,
      },
    }));
    const result = readPiCachedModels('http://localhost:8080/v1', tmpHome);
    expect(result).toEqual(['model-a', 'model-b']);
  });

  it('matches by baseUrl when there are multiple cache entries', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), JSON.stringify({
      'llama-local': {
        baseUrl: 'http://localhost:8080/v1',
        models: [{ id: 'local-model' }],
      },
      'llama-remote': {
        baseUrl: 'http://server.example.com:8000/v1',
        models: [{ id: 'remote-model-1' }, { id: 'remote-model-2' }],
      },
    }));
    expect(readPiCachedModels('http://localhost:8080/v1', tmpHome)).toEqual(['local-model']);
    expect(readPiCachedModels('http://server.example.com:8000/v1', tmpHome)).toEqual(['remote-model-1', 'remote-model-2']);
  });
});

describe('readPiCachedModelInfo', () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('returns an empty map when cache file does not exist', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    expect(readPiCachedModelInfo('http://localhost:8080/v1', tmpHome).size).toBe(0);
  });

  it('returns an empty map when baseUrl is not in cache', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), JSON.stringify({
      'llama-cpp': { baseUrl: 'http://other:9090/v1', models: [{ id: 'x', reasoning: true }] },
    }));
    expect(readPiCachedModelInfo('http://localhost:8080/v1', tmpHome).size).toBe(0);
  });

  it('returns reasoning, contextWindow, and maxTokens for each model', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), JSON.stringify({
      'llama-cpp': {
        baseUrl: 'http://localhost:8080/v1',
        models: [
          { id: 'thinker', reasoning: true, contextWindow: 200000, maxTokens: 200000 },
          { id: 'vanilla', reasoning: false, contextWindow: 32000, maxTokens: 16000 },
          { id: 'unknown' },
        ],
      },
    }));
    const info = readPiCachedModelInfo('http://localhost:8080/v1', tmpHome);
    expect(info.get('thinker')).toMatchObject({ id: 'thinker', reasoning: true, contextWindow: 200000, maxTokens: 200000 });
    expect(info.get('vanilla')).toMatchObject({ id: 'vanilla', reasoning: false, contextWindow: 32000, maxTokens: 16000 });
    expect(info.get('unknown')).toMatchObject({ id: 'unknown', reasoning: false, contextWindow: 128_000, maxTokens: 8_192 }); // absent → defaults
  });

  it('keys the map by model id for O(1) lookup', () => {
    tmpHome = path.join(os.tmpdir(), `pi-home-${Date.now()}`);
    const agentDir = makePiAgentDir(tmpHome);
    fs.writeFileSync(path.join(agentDir, 'llama-cpp-cache.json'), JSON.stringify({
      'llama-cpp': {
        baseUrl: 'http://localhost:8080/v1',
        models: [{ id: 'model-a', reasoning: true }, { id: 'model-b', reasoning: false }],
      },
    }));
    const info = readPiCachedModelInfo('http://localhost:8080/v1', tmpHome);
    expect(info.size).toBe(2);
    expect(info.has('model-a')).toBe(true);
    expect(info.has('model-b')).toBe(true);
    expect(info.has('model-c')).toBe(false);
  });
});
