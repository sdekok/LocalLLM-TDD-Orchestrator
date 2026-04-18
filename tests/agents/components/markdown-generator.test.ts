import { describe, it, expect } from 'vitest';
import { generatePlanMarkdown, formatWorkItemMarkdown } from '../../../src/agents/components/markdown-generator.js';
import type { ProjectPlan } from '../../../src/agents/project-plan-schema.js';

describe('formatWorkItemMarkdown', () => {
  it('uses #### sub-headers under ### work item header', () => {
    const lines = formatWorkItemMarkdown({
      id: 'WI-1',
      title: 'Login Form',
      description: 'Build a login form.',
      acceptance: ['Form submits'],
      tests: ['Should render'],
    });
    const md = lines.join('\n');

    // Work item is h3
    expect(md).toContain('### WI-1: Login Form');
    // Sub-sections are h4, not h2
    expect(md).toContain('#### Summary');
    expect(md).toContain('#### Acceptance Criteria');
    expect(md).toContain('#### Recommended Tests');
    expect(md).not.toMatch(/^## /m);
  });

  it('renders acceptance criteria with checkboxes', () => {
    const lines = formatWorkItemMarkdown({
      id: 'WI-1',
      title: 'Task',
      description: 'Desc',
      acceptance: ['First', 'Second'],
      tests: [],
    });
    const md = lines.join('\n');
    expect(md).toContain('- [ ] First');
    expect(md).toContain('- [ ] Second');
  });

  it('renders all optional fields when present', () => {
    const lines = formatWorkItemMarkdown({
      id: 'WI-1',
      title: 'Full Item',
      description: 'Complete work item.',
      filesToCreate: ['src/new.ts - new module'],
      filesToModify: ['src/old.ts - add export'],
      dependencies: { read: ['docs/api.md'], blocksOn: ['WI-0'] },
      implementationSteps: ['Step 1', 'Step 2'],
      technicalConstraints: ['Use zod'],
      acceptance: ['Works'],
      tests: ['Unit: test'],
      edgeCases: ['Empty input'],
      security: 'Sanitize inputs',
      devNotes: 'Check upstream API',
      relatedDocs: ['docs/guide.md'],
    });
    const md = lines.join('\n');

    expect(md).toContain('#### Files To Create/Modify');
    expect(md).toContain('`src/new.ts - new module` - new');
    expect(md).toContain('`src/old.ts - add export` - modify');
    expect(md).toContain('#### Dependencies');
    expect(md).toContain('Read: `docs/api.md`');
    expect(md).toContain('Blocks on: WI-0');
    expect(md).toContain('#### Implementation Steps');
    expect(md).toContain('1. Step 1');
    expect(md).toContain('2. Step 2');
    expect(md).toContain('#### Technical Constraints');
    expect(md).toContain('- Use zod');
    expect(md).toContain('#### Edge Cases to Handle');
    expect(md).toContain('- Empty input');
    expect(md).toContain('#### Security');
    expect(md).toContain('Sanitize inputs');
    expect(md).toContain('#### Dev Notes');
    expect(md).toContain('Check upstream API');
    expect(md).toContain('#### Related Docs');
    expect(md).toContain('`docs/guide.md`');
  });

  it('omits optional sections when not provided', () => {
    const lines = formatWorkItemMarkdown({
      id: 'WI-1',
      title: 'Minimal',
      description: 'Just the basics.',
      acceptance: ['Works'],
      tests: [],
    });
    const md = lines.join('\n');

    expect(md).not.toContain('#### Files To Create/Modify');
    expect(md).not.toContain('#### Dependencies');
    expect(md).not.toContain('#### Implementation Steps');
    expect(md).not.toContain('#### Technical Constraints');
    expect(md).not.toContain('#### Edge Cases');
    expect(md).not.toContain('#### Security');
    expect(md).not.toContain('#### Dev Notes');
    expect(md).not.toContain('#### Related Docs');
    // Empty tests array should still not render the section
    expect(md).not.toContain('#### Recommended Tests');
  });

  it('ends with a --- divider', () => {
    const lines = formatWorkItemMarkdown({
      id: 'WI-1',
      title: 'Task',
      description: 'Desc',
      acceptance: ['Done'],
      tests: [],
    });
    // Last two lines: '---' and ''
    expect(lines[lines.length - 2]).toBe('---');
    expect(lines[lines.length - 1]).toBe('');
  });
});

describe('generatePlanMarkdown', () => {
  it('nests work item #### headers under epic ### headers', () => {
    const plan: ProjectPlan = {
      summary: 'Test Project',
      epics: [{
        title: 'Epic One',
        slug: 'epic-one',
        description: 'First epic.',
        workItems: [{
          id: 'WI-1',
          title: 'Task One',
          description: 'Do thing.',
          acceptance: ['Done'],
          tests: ['Unit: test'],
        }],
      }],
      architecturalDecisions: ['Use TypeScript'],
    };

    const md = generatePlanMarkdown(plan);

    expect(md).toContain('# Project Plan: Test Project');
    expect(md).toContain('## Epic 1: Epic One');
    expect(md).toContain('### WI-1: Task One');
    expect(md).toContain('#### Summary');
    expect(md).toContain('#### Acceptance Criteria');
    // No h2 inside work items
    const workItemSection = md.split('### WI-1')[1]!;
    expect(workItemSection).not.toMatch(/^## /m);
  });
});
