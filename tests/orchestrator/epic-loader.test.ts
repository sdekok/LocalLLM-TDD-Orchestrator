import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EpicLoader } from '../../src/orchestrator/epic-loader.js';

describe('EpicLoader', () => {
  let tempDir: string;
  let workItemsDir: string;
  let loader: EpicLoader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-loader-test-'));
    workItemsDir = path.join(tempDir, 'WorkItems');
    fs.mkdirSync(workItemsDir);
    loader = new EpicLoader(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sampleEpic = `
# Epic: Auth System

## Summary
Build an authentication system.

## Dependencies
- Epic 0 (DB Setup)
- Epic 1 (Frontend)

## Architectural Decisions
- Use JWT
- Use bcrypt

## Work Items

### WI-1: Login Route
**Description**: The login route should handle POST requests.
**Acceptance Criteria**:
- 200 on success.

### WI-2: Register Route
**Description**: The register route should handle POST requests.
**Acceptance Criteria**:
- 210 on success.

## Status
- [ ] WI-1
- [ ] WI-2
`;

  it('should fuzzy find an epic by filename prefix', () => {
    const filePath = path.join(workItemsDir, 'epic-01-auth-system.md');
    fs.writeFileSync(filePath, sampleEpic);

    expect(loader.findEpic('epic-01')).toBe(filePath);
    expect(loader.findEpic('Epic 01')).toBe(filePath);
    expect(loader.findEpic('auth-system')).toBe(filePath);
  });

  it('should find an epic by searching inside content for title', () => {
    const filePath = path.join(workItemsDir, 'random-filename.md');
    fs.writeFileSync(filePath, sampleEpic);

    expect(loader.findEpic('Auth System')).toBe(filePath);
  });

  it('should parse an epic markdown file correctly', () => {
    const filePath = path.join(workItemsDir, 'epic-01.md');
    fs.writeFileSync(filePath, sampleEpic);

    const plan = loader.parseEpic(filePath);

    expect(plan.title).toBe('Auth System');
    expect(plan.summary).toBe('Build an authentication system.');
    expect(plan.dependencies).toContain('Epic 0 (DB Setup)');
    expect(plan.architecturalDecisions).toContain('Use JWT');
    expect(plan.workItems).toHaveLength(2);
    
    expect(plan.workItems[0]?.id).toBe('WI-1');
    expect(plan.workItems[0]?.title).toBe('Login Route');
    expect(plan.workItems[0]?.description).toContain('The login route should handle POST requests.');
    expect(plan.workItems[0]?.acceptance).toContain('200 on success.');
    
    expect(plan.workItems[1]?.id).toBe('WI-2');
    expect(plan.workItems[1]?.title).toBe('Register Route');
  });

  it('should handle missing sections gracefully', () => {
    const minimalEpic = '# Epic: Minimal\n### WI-1: Task\n**Description**: Description';
    const filePath = path.join(workItemsDir, 'minimal.md');
    fs.writeFileSync(filePath, minimalEpic);

    const plan = loader.parseEpic(filePath);
    expect(plan.title).toBe('Minimal');
    expect(plan.workItems).toHaveLength(1);
    expect(plan.summary).toBe('');
  });
});
