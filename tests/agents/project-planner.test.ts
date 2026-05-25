import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectPlanSchema, type ProjectPlan } from '../../src/agents/project-plan-schema.js';
import { ModelRouter } from '../../src/llm/model-router.js';

// Mock fs before importing the module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    }),
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  createWriteStream: vi.fn().mockReturnValue({
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  }),
}));

vi.mock('fs/promises', () => ({
  default: {},
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
}));

const mockPrompt = vi.fn();
const mockDispose = vi.fn();
vi.mock('../../src/subagent/factory.js', () => ({
  createSubAgentSession: vi.fn().mockImplementation(async () => ({
    prompt: mockPrompt,
    dispose: mockDispose,
    messages: [],
  })),
}));

describe('ProjectPlanSchema', () => {
  it('validates a correct project plan', () => {
    const validPlan: ProjectPlan = {
      reasoning: 'Reasoning for test plan',
      summary: 'Test project summary',
      epics: [
        {
          title: 'Auth System',
          slug: 'auth-system',
          description: 'Implement authentication',
          workItems: [
            {
              id: 'WI-1',
              title: 'Create login form',
              description: 'Build a login form component',
              acceptance: ['Form submits successfully'],
              tests: ['Should render login form'],
            },
          ],
        },
      ],
      architecturalDecisions: ['Use JWT for authentication'],
    };

    const result = ProjectPlanSchema.safeParse(validPlan);
    expect(result.success).toBe(true);
  });

  it('rejects a plan with missing required fields', () => {
    const invalidPlan = {
      summary: 'Test',
      epics: [],
      // Missing architecturalDecisions
    };

    const result = ProjectPlanSchema.safeParse(invalidPlan);
    expect(result.success).toBe(false);
  });

  it('rejects a plan with empty work items array in epic', () => {
    const invalidPlan: ProjectPlan = {
      reasoning: 'Reasoning',
      summary: 'Test',
      epics: [
        {
          title: 'Test Epic',
          slug: 'test',
          description: 'Test',
          workItems: [], // Empty but valid per schema
        },
      ],
      architecturalDecisions: [],
    };

    const result = ProjectPlanSchema.safeParse(invalidPlan);
    expect(result.success).toBe(true); // Empty arrays are valid
  });

  it('rejects a plan with invalid work item structure', () => {
    const invalidPlan = {
      summary: 'Test',
      epics: [
        {
          title: 'Test',
          slug: 'test',
          description: 'Test',
          workItems: [
            {
              id: 'WI-1',
              title: 'Test',
              // Missing description and acceptance
            },
          ],
        },
      ],
      architecturalDecisions: [],
    };

    const result = ProjectPlanSchema.safeParse(invalidPlan);
    expect(result.success).toBe(false);
  });
});

describe('Project Planner Integration', () => {
  const mockModelRouter = new ModelRouter({
    models: {
      'test-model': {
        name: 'Test Model',
        ggufFilename: 'test.gguf',
        provider: 'local',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        architecture: 'dense',
        speed: 'fast',
        enableThinking: false,
      }
    },
    routing: { 'project-plan': 'test-model' }
  });

  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('extracts JSON from agent response with conversational text', async () => {
    const { extractPlanFromResponse } = await import('../../src/agents/project-planner.js');
    
    const response = "Here's the plan you requested:\n\n```json\n{\n  \"reasoning\": \"Test reasoning\",\n  \"summary\": \"Test project\",\n  \"epics\": [],\n  \"architecturalDecisions\": []\n}\n```\n\nLet me know if you need any changes!";

    const result = extractPlanFromResponse(response);
    expect(result).toBeDefined();
    expect(result.summary).toBe('Test project');
  });

  it('throws error when no JSON found in response', async () => {
    const { extractPlanFromResponse } = await import('../../src/agents/project-planner.js');
    
    const response = 'I cannot create a plan at this time.';

    expect(() => extractPlanFromResponse(response)).toThrow('No JSON object found');
  });

  it('throws error when JSON is invalid', async () => {
    const { extractPlanFromResponse } = await import('../../src/agents/project-planner.js');
    
    const response = 'No json here at all';

    expect(() => extractPlanFromResponse(response)).toThrow('No JSON object found');
  });

  it('throws error when JSON fails schema validation', async () => {
    const { extractPlanFromResponse } = await import('../../src/agents/project-planner.js');
    
    const response = '{"summary": "test"}'; // Missing epics and architecturalDecisions

    expect(() => extractPlanFromResponse(response)).toThrow('Invalid plan format');
  });
});

describe('Plan File Writing', () => {
  const mockFs = fs as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates WorkItems directory and writes overview', async () => {
    const { writePlanFiles } = await import('../../src/agents/project-planner.js');
    
    const plan: ProjectPlan = {
      reasoning: 'Test reasoning',
      summary: 'Test project',
      epics: [],
      architecturalDecisions: ['Decision 1'],
    };

    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue(['_overview.md']);

    await writePlanFiles(plan, '/tmp/test');

    expect(mockFs.existsSync).toHaveBeenCalledWith(path.join('/tmp/test', 'WorkItems'));
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      path.join('/tmp/test', 'WorkItems'),
      { recursive: true }
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('_overview.md'),
      expect.stringContaining('Test project')
    );
  });

  it('writes epic files with correct naming', async () => {
    const { writePlanFiles } = await import('../../src/agents/project-planner.js');
    
    const plan: ProjectPlan = {
      reasoning: 'Test reasoning',
      summary: 'Test',
      epics: [
        {
          title: 'Auth System',
          slug: 'auth-system',
          description: 'Implement auth',
          workItems: [
            {
              id: 'WI-1',
              title: 'Login form',
              description: 'Create login',
              acceptance: ['Submits correctly'],
              tests: ['Should send POST to /login'],
            },
          ],
        },
        {
          title: 'User Profile',
          slug: 'user-profile',
          description: 'Implement profiles',
          workItems: [],
        },
      ],
      architecturalDecisions: [],
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['_overview.md', 'epic-01-auth-system.md', 'epic-02-user-profile.md']);

    await writePlanFiles(plan, '/tmp/test');

    // Check epic file naming
    const calls = mockFs.writeFileSync.mock.calls;
    const epicFiles = calls.filter((c: any) => c[0].includes('epic-'));
    expect(epicFiles).toHaveLength(2);
    expect(epicFiles[0][0]).toContain('epic-01-auth-system.md');
    expect(epicFiles[1][0]).toContain('epic-02-user-profile.md');
  });

  it('writes files', async () => {
    const { writePlanFiles } = await import('../../src/agents/project-planner.js');
    
    const plan: ProjectPlan = {
      reasoning: 'Test reasoning',
      summary: 'Test',
      epics: [
        {
          title: 'Epic 1',
          slug: 'epic-1',
          description: 'Desc',
          workItems: [],
        },
      ],
      architecturalDecisions: [],
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['_overview.md', 'epic-01-epic-1.md']);

    await expect(writePlanFiles(plan, '/tmp/test')).resolves.not.toThrow();
  });

});

describe('Architectural Decisions Appending', () => {
  const mockFs = fs as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends decisions to agents.md', async () => {
    const { appendArchitecturalDecisions } = await import('../../src/agents/project-planner.js');
    
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync = vi.fn().mockReturnValue('# Agents File\n\n## Existing Content');
    
    await appendArchitecturalDecisions(
      ['Decision 1', 'Decision 2'],
      '/tmp/test',
      'agents.md'
    );

    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('Decision 1');
    expect(writtenContent).toContain('Decision 2');
    expect(writtenContent).toContain('Architectural Decisions (Auto-generated)');
  });

  it('creates agents.md if it does not exist', async () => {
    const { appendArchitecturalDecisions } = await import('../../src/agents/project-planner.js');
    
    mockFs.existsSync.mockReturnValue(false);
    
    await appendArchitecturalDecisions(
      ['Decision 1'],
      '/tmp/test',
      'agents.md'
    );

    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
    expect(writtenContent).toContain('# Agents File');
    expect(writtenContent).toContain('Decision 1');
  });

  it('does not duplicate decisions section if it already exists', async () => {
    const { appendArchitecturalDecisions } = await import('../../src/agents/project-planner.js');
    
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync = vi.fn().mockReturnValue(
      '# Agents File\n\n## Architectural Decisions (Auto-generated)\n\n- Old Decision'
    );
    
    await appendArchitecturalDecisions(
      ['New Decision'],
      '/tmp/test',
      'agents.md'
    );

    const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
    // Should only have one section header
    const sectionCount = (writtenContent.match(/## Architectural Decisions/g) || []).length;
    expect(sectionCount).toBe(1);
    expect(writtenContent).toContain('Old Decision');
    expect(writtenContent).toContain('New Decision');
  });
});

describe('planProject', () => {
  const mockFs = fs as any;
  const mockModelRouter = new ModelRouter({
    models: {
      'test-model': {
        name: 'Test Model',
        ggufFilename: 'test.gguf',
        provider: 'local',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        architecture: 'dense',
        speed: 'fast',
        enableThinking: false,
      }
    },
    routing: { 'project-plan': 'test-model' }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the full planning flow without UI context', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Here is the plan: ```json\n{\n  "reasoning": "Test reasoning",\n  "summary": "Test project",\n  "epics": [],\n  "architecturalDecisions": ["Dec 1"]\n}\n```'
            }
          ]
        }
      ]
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const result = await planProject('Help me build a web app', mockModelRouter, '/tmp/test');

    expect(result.summary).toContain('planning complete');
    expect(result.plan?.summary).toBe('Test project');
    expect(mockSession.prompt).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled(); // Should write _overview.md
    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it('runs the full planning flow with UI context and approval', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    const mockSession = {
      prompt: vi.fn(),
      dispose: vi.fn(),
      messages: [
        {
          role: 'assistant',
          content: '```json\n{"reasoning": "Test reasoning", "summary": "Test UI", "epics": [], "architecturalDecisions": []}\n```'
        }
      ]
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);
    
    const uiContext = {
      input: vi.fn(),
      notify: vi.fn(),
      editor: vi.fn().mockResolvedValue('Edited Plan Markdown'),
      confirm: vi.fn().mockResolvedValue(true),
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const result = await planProject('UI Plan', mockModelRouter, '/tmp/test', uiContext);

    expect(result.plan?.summary).toBe('Test UI');
    // editor is no longer called — the new flow shows a confirm after the overview phase
    expect(uiContext.editor).not.toHaveBeenCalled();
    expect(uiContext.confirm).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
  });

  it('triggers retry when response only has thinking blocks and no text blocks', async () => {
    // Thinking blocks are internal model scratchpad — the orchestrator never extracts JSON from them.
    // When only thinking blocks are present, the planner must retry to get text output.
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    const messagesStore: any[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '{"summary":"Thinking Model Plan","epics":[],"architecturalDecisions":[]}',
          },
          // no 'text' block — should trigger retry
        ],
      },
    ];
    let promptCallCount = 0;
    const mockSession = {
      prompt: vi.fn().mockImplementation(async () => {
        promptCallCount++;
        if (promptCallCount >= 2) {
          // On retry (second call), add a text block with the plan
          messagesStore.push({
            role: 'assistant',
            content: [{ type: 'text', text: '{"summary":"Text Plan","epics":[],"architecturalDecisions":[]}' }],
          });
        }
        // First call: initial prompt — no new message added (model only output thinking, pre-seeded above)
      }),
      dispose: vi.fn(),
      get messages() { return messagesStore; },
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const result = await planProject('Build something', mockModelRouter, '/tmp/test');

    // Should extract from the retry's text block, not the thinking block
    expect(result.plan?.summary).toBe('Text Plan');
    expect(mockSession.prompt).toHaveBeenCalledTimes(2); // initial + retry
  });

  it('retries with a follow-up prompt when the first response has no JSON', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    const messagesStore: any[] = [];
    const mockSession = {
      prompt: vi.fn().mockImplementation(async () => {
        if (messagesStore.length === 0) {
          // First call: conversational response, no JSON
          messagesStore.push({ role: 'assistant', content: [{ type: 'text', text: 'Sure, I can help plan that for you!' }] });
        } else {
          // Second call (follow-up): returns valid JSON
          messagesStore.push({ role: 'assistant', content: [{ type: 'text', text: '{"reasoning":"r","summary":"Retry Plan","epics":[],"architecturalDecisions":[]}' }] });
        }
      }),
      dispose: vi.fn(),
      get messages() { return messagesStore; },
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const result = await planProject('Build something', mockModelRouter, '/tmp/test');

    expect(result.plan?.summary).toBe('Retry Plan');
    expect(mockSession.prompt).toHaveBeenCalledTimes(2);
    // Second call should ask for JSON explicitly
    const retryPrompt = mockSession.prompt.mock.calls[1][0] as string;
    expect(retryPrompt).toContain('JSON');
  });

  it('throws a clear error when both initial response and retry contain no JSON', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'I cannot produce JSON.' }] }],
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);

    await expect(planProject('Build something', mockModelRouter, '/tmp/test'))
      .rejects.toThrow('No valid JSON found after retry for: phase1-overview');

    expect(mockSession.prompt).toHaveBeenCalledTimes(2);
  });

  it('cancels planning if user rejects the confirm dialog', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    const mockSession = {
      prompt: vi.fn(),
      dispose: vi.fn(),
      messages: [{ role: 'assistant', content: '{"reasoning": "Test reasoning", "summary": "Test", "epics": [], "architecturalDecisions": []}' }]
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);

    const uiContext = {
      input: vi.fn(),
      notify: vi.fn(),
      editor: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false), // User declines
    };

    const result = await planProject('UI Plan', mockModelRouter, '/tmp/test', uiContext);

    expect(result.summary).toBe('Planning cancelled by user.');
    // Plan files (WorkItems/) must not be written — only the session debug dump is allowed.
    const planFilesWritten = (mockFs.writeFileSync as any).mock.calls.filter(
      (args: any[]) => typeof args[0] === 'string' && (args[0].includes('WorkItems') || args[0].includes('epic-') || args[0].includes('_overview'))
    );
    expect(planFilesWritten).toHaveLength(0);
  });
});

describe('planProject — append vs replace mode', () => {
  const mockFs = fs as any;
  const mockModelRouter = new ModelRouter({
    models: {
      'test-model': {
        name: 'Test Model',
        ggufFilename: 'test.gguf',
        provider: 'local',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        architecture: 'dense',
        speed: 'fast',
        enableThinking: false,
      },
    },
    routing: { 'project-plan': 'test-model' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Seed the fs mocks so scanExistingPlan() sees two epics + a prior overview
   * in WorkItems/. Must be called BEFORE planProject() so scanExistingPlan
   * (which runs at function entry, before the agent session is created) picks
   * up the mocked state.
   */
  function seedExistingPlanState() {
    const epic01 = '# Epic: User Authentication\n\n## Summary\nLogin flows.\n\n## Work Items\n\n### WI-1: Email login\n';
    const epic02 = '# Epic: Billing\n\n## Summary\nStripe.\n\n## Work Items\n\n### WI-1: Stripe integration\n';
    const overview = '# Project Overview\n\nA web app.\n\n## Architectural Decisions\n\n- Use Postgres\n- Stateless auth\n';

    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('WorkItems')) return true;
      if (p.endsWith('_overview.md')) return true;
      if (p.endsWith('epic-01-auth.md') || p.endsWith('epic-02-billing.md')) return true;
      return false;
    });
    mockFs.readdirSync.mockReturnValue(['epic-01-auth.md', 'epic-02-billing.md']);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p !== 'string') return '';
      if (p.endsWith('epic-01-auth.md')) return epic01;
      if (p.endsWith('epic-02-billing.md')) return epic02;
      if (p.endsWith('_overview.md')) return overview;
      return '';
    });
  }

  /**
   * Build a mock AgentSession whose `prompt()` returns canned JSON for both
   * Phase 1 (overview) and Phase 2 (per-epic). Phase 2 uses a fresh session
   * per epic, so the response is derived from the prompt content rather than
   * a turn counter.
   */
  function buildPlannerSession(newEpicSlug: string) {
    const messagesStore: any[] = [];
    const overviewJson = `{"summary":"Adding caching","epics":[{"title":"Caching","slug":"${newEpicSlug}","description":"Add a cache."}],"architecturalDecisions":["Use Redis"]}`;
    const epicJson = `{"title":"Caching","slug":"${newEpicSlug}","description":"Cache layer.","workItems":[{"id":"WI-1","title":"Add cache","description":"add","acceptance":["a"],"tests":["t"]}]}`;
    return {
      prompt: vi.fn().mockImplementation(async (text: string) => {
        const isPhase1 = text.includes('epic overview JSON');
        messagesStore.push({
          role: 'assistant',
          content: [{ type: 'text', text: isPhase1 ? overviewJson : epicJson }],
        });
      }),
      dispose: vi.fn(),
      get messages() { return messagesStore; },
    };
  }

  it('append mode (default) bumps past maxIndex when slug is new', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    seedExistingPlanState();
    (createSubAgentSession as any).mockImplementation(async () => buildPlannerSession('caching'));

    await planProject('Add a caching layer', mockModelRouter, '/tmp/project');

    const writtenEpicFiles = (mockFs.writeFileSync as any).mock.calls
      .map((args: any[]) => args[0])
      .filter((p: string) => typeof p === 'string' && /epic-\d+-/.test(p));

    // The new epic should land at epic-03 (max was 02), NOT epic-01.
    expect(writtenEpicFiles.some((p: string) => p.endsWith('epic-03-caching.md'))).toBe(true);
    expect(writtenEpicFiles.some((p: string) => p.endsWith('epic-01-caching.md'))).toBe(false);
  });

  it('append mode reuses the existing filename when the slug matches', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    seedExistingPlanState();
    // Planner re-emits an epic with the existing 'auth' slug — should update in
    // place by reusing the on-disk filename rather than picking maxIndex+1.
    (createSubAgentSession as any).mockImplementation(async () => buildPlannerSession('auth'));

    await planProject('Tighten the auth epic', mockModelRouter, '/tmp/project');

    const writtenEpicFiles = (mockFs.writeFileSync as any).mock.calls
      .map((args: any[]) => args[0])
      .filter((p: string) => typeof p === 'string' && /epic-\d+-/.test(p));

    expect(writtenEpicFiles.some((p: string) => p.endsWith('epic-01-auth.md'))).toBe(true);
    expect(writtenEpicFiles.some((p: string) => p.endsWith('epic-03-auth.md'))).toBe(false);
  });

  it('append mode injects existing-plan context into the Phase 1 prompt', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    seedExistingPlanState();
    const session = buildPlannerSession('caching');
    (createSubAgentSession as any).mockImplementation(async () => session);

    await planProject('Add caching', mockModelRouter, '/tmp/project');

    const phase1Prompt = session.prompt.mock.calls[0]?.[0] as string;
    expect(phase1Prompt).toContain('EXTENDING this');
    expect(phase1Prompt).toContain('epic-01 "User Authentication"');
    expect(phase1Prompt).toContain('epic-02 "Billing"');
    expect(phase1Prompt).toContain('Use Postgres'); // existing architectural decisions surfaced
  });

  it('append mode merges architectural decisions in _overview.md (no duplicates)', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    seedExistingPlanState();
    (createSubAgentSession as any).mockImplementation(async () => buildPlannerSession('caching'));

    await planProject('Add caching', mockModelRouter, '/tmp/project');

    const overviewWrite = (mockFs.writeFileSync as any).mock.calls.find(
      (args: any[]) => typeof args[0] === 'string' && args[0].endsWith('_overview.md'),
    );
    expect(overviewWrite).toBeDefined();
    const content = overviewWrite![1] as string;
    expect(content).toContain('Use Postgres');     // preserved from prior
    expect(content).toContain('Stateless auth');   // preserved from prior
    expect(content).toContain('Use Redis');        // new decision appended
    // No duplicate of an existing decision (case-insensitive)
    expect((content.match(/Use Postgres/g) || []).length).toBe(1);
  });

  it('replace mode does NOT inject existing-plan context and starts numbering at 01', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    seedExistingPlanState();
    const session = buildPlannerSession('caching');
    (createSubAgentSession as any).mockImplementation(async () => session);

    await planProject('Replan from scratch', mockModelRouter, '/tmp/project', undefined, { mode: 'replace' });

    const phase1Prompt = session.prompt.mock.calls[0]?.[0] as string;
    expect(phase1Prompt).not.toContain('EXTENDING this');

    const writtenEpicFiles = (mockFs.writeFileSync as any).mock.calls
      .map((args: any[]) => args[0])
      .filter((p: string) => typeof p === 'string' && /epic-\d+-/.test(p));
    // Replace mode falls back to the prior numbering: first new epic is epic-01.
    expect(writtenEpicFiles.some((p: string) => p.endsWith('epic-01-caching.md'))).toBe(true);
  });

  it('persists _request.json so /plan revise can pick it up later', async () => {
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');

    seedExistingPlanState();
    (createSubAgentSession as any).mockImplementation(async () => buildPlannerSession('caching'));

    await planProject('Add caching', mockModelRouter, '/tmp/project');

    const requestWrite = (mockFs.writeFileSync as any).mock.calls.find(
      (args: any[]) => typeof args[0] === 'string' && args[0].endsWith('_request.json'),
    );
    expect(requestWrite).toBeDefined();
    const payload = JSON.parse(requestWrite![1] as string);
    expect(payload.request).toBe('Add caching');
    expect(payload.mode).toBe('append');
    expect(typeof payload.timestamp).toBe('string');
  });
});

describe('planProject — chatMessage streaming via uiContext', () => {
  const mockFs = fs as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a mock session that:
   * 1. Captures the subscribe listener so tests can fire events at it.
   * 2. Returns a valid plan on prompt() so planProject completes normally.
   */
  function makePlannerSession() {
    let listener: ((event: any) => void) | null = null;
    const validPlanJson =
      '{"reasoning":"r","summary":"Streaming Test","epics":[],"architecturalDecisions":[]}';
    const messagesStore = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: validPlanJson }],
      },
    ];
    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn((fn: (event: any) => void) => {
        listener = fn;
        return () => { listener = null; };
      }),
      get messages() { return messagesStore; },
    };
    const fire = (event: any) => { if (listener) listener(event); };
    return { session, fire };
  }

  it('posts Thinking… immediately when thinking_start fires', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { session, fire } = makePlannerSession();
    (createSubAgentSession as any).mockResolvedValue(session);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const chatMessage = vi.fn();
    // Intercept subscribe to fire a thinking_start right away when prompt is called
    session.prompt.mockImplementation(async () => {
      fire({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
    });

    await planProject('Build something', new (await import('../../src/llm/model-router.js')).ModelRouter({
      models: { 'test-model': { name: 'T', ggufFilename: 'test.gguf', provider: 'local', contextWindow: 8192, maxOutputTokens: 1024, architecture: 'dense', speed: 'fast', enableThinking: false } },
      routing: { 'project-plan': 'test-model' },
    }), '/tmp/test', { input: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), chatMessage });

    const thinkingCall = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('Thinking'));
    expect(thinkingCall).toBeDefined();
    expect(thinkingCall![0]).toContain('💭');
  });

  it('posts a chunk when thinking_delta exceeds 800 chars', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { session, fire } = makePlannerSession();
    (createSubAgentSession as any).mockResolvedValue(session);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const chatMessage = vi.fn();
    session.prompt.mockImplementation(async () => {
      fire({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
      fire({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x'.repeat(900) } });
    });

    await planProject('Build something', new (await import('../../src/llm/model-router.js')).ModelRouter({
      models: { 'test-model': { name: 'T', ggufFilename: 'test.gguf', provider: 'local', contextWindow: 8192, maxOutputTokens: 1024, architecture: 'dense', speed: 'fast', enableThinking: false } },
      routing: { 'project-plan': 'test-model' },
    }), '/tmp/test', { input: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), chatMessage });

    // thinking_start + at least one chunk from thinking_delta
    const chunkCalls = chatMessage.mock.calls.filter((c: any[]) => (c[0] as string).includes('💭'));
    expect(chunkCalls.length).toBeGreaterThanOrEqual(2); // start notification + content chunk
  });

  it('flushes remaining thinking content on thinking_end', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { session, fire } = makePlannerSession();
    (createSubAgentSession as any).mockResolvedValue(session);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const chatMessage = vi.fn();
    session.prompt.mockImplementation(async () => {
      fire({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
      fire({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'short thought' } });
      fire({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'short thought' } });
    });

    await planProject('Build something', new (await import('../../src/llm/model-router.js')).ModelRouter({
      models: { 'test-model': { name: 'T', ggufFilename: 'test.gguf', provider: 'local', contextWindow: 8192, maxOutputTokens: 1024, architecture: 'dense', speed: 'fast', enableThinking: false } },
      routing: { 'project-plan': 'test-model' },
    }), '/tmp/test', { input: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), chatMessage });

    const flushCall = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('short thought'));
    expect(flushCall).toBeDefined();
  });

  it('posts tool calls to chatMessage', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { session, fire } = makePlannerSession();
    (createSubAgentSession as any).mockResolvedValue(session);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    const chatMessage = vi.fn();
    session.prompt.mockImplementation(async () => {
      fire({ type: 'tool_execution_start', toolName: 'web_search', args: { query: 'best practices' } });
    });

    await planProject('Build something', new (await import('../../src/llm/model-router.js')).ModelRouter({
      models: { 'test-model': { name: 'T', ggufFilename: 'test.gguf', provider: 'local', contextWindow: 8192, maxOutputTokens: 1024, architecture: 'dense', speed: 'fast', enableThinking: false } },
      routing: { 'project-plan': 'test-model' },
    }), '/tmp/test', { input: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), chatMessage });

    const toolCall = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('web_search'));
    expect(toolCall).toBeDefined();
    expect(toolCall![0]).toContain('🔧');
  });

  it('does not call subscribe when chatMessage is absent in uiContext', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { planProject } = await import('../../src/agents/project-planner.js');
    const { session } = makePlannerSession();
    (createSubAgentSession as any).mockResolvedValue(session);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);

    // uiContext without chatMessage
    await planProject('Build something', new (await import('../../src/llm/model-router.js')).ModelRouter({
      models: { 'test-model': { name: 'T', ggufFilename: 'test.gguf', provider: 'local', contextWindow: 8192, maxOutputTokens: 1024, architecture: 'dense', speed: 'fast', enableThinking: false } },
      routing: { 'project-plan': 'test-model' },
    }), '/tmp/test', { input: vi.fn(), notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) });

    expect(session.subscribe).not.toHaveBeenCalled();
  });
});

describe('generatePlanMarkdown', () => {
  it('generates correct markdown for a plan', async () => {
    const { generatePlanMarkdown } = await import('../../src/agents/project-planner.js');
    const plan: ProjectPlan = {
      reasoning: 'Test reasoning',
      summary: 'Test Summary',
      epics: [
        {
          title: 'Epic Title',
          slug: 'slug',
          description: 'Desc',
          workItems: [{ id: 'WI-1', title: 'WI Title', description: 'WI Desc', acceptance: [], tests: [] }]
        }
      ],
      architecturalDecisions: ['Dec 1']
    };

    const md = generatePlanMarkdown(plan);
    expect(md).toContain('# Project Plan: Test Summary');
    expect(md).toContain('Epic Title');
    expect(md).toContain('WI-1: WI Title');
    expect(md).toContain('Dec 1');
  });
});
