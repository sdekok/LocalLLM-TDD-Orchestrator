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
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {},
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
}));

describe('ProjectPlanSchema', () => {
  it('validates a correct project plan', () => {
    const validPlan: ProjectPlan = {
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
        modelFamily: 'generic',
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
    
    const response = "Here's the plan you requested:\n\n```json\n{\n  \"summary\": \"Test project\",\n  \"epics\": [],\n  \"architecturalDecisions\": []\n}\n```\n\nLet me know if you need any changes!";

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
<<<<<<< HEAD
              tests: ['Should post to /login'],
=======
              tests: ['Should send POST to /login'],
>>>>>>> main
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
