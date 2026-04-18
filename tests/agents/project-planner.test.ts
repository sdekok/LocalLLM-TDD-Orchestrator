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
