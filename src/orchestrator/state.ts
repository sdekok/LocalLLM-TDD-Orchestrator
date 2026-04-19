import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getLogger } from '../utils/logger.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type TaskPhase = 'refining' | 'implementing' | 'quality_gates' | 'reviewing' | 'merging';

export interface Subtask {
  id: string;
  description: string;
  status: TaskStatus;
  phase?: TaskPhase;
  tests_written: boolean;
  code_implemented: boolean;
  attempts: number;
  feedback?: string;
  test_failures?: string;
  acceptance?: string[];
  security?: string;
  tests?: string[];
  devNotes?: string;
}

export interface WorkflowState {
  original_request: string;
  refined_request: string;
  subtasks: Subtask[];
}

export class StateManager {
  private state: WorkflowState;
  private stateFile: string;
  public readonly projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    const workflowDir = path.join(projectDir, '.tdd-workflow');
    fs.mkdirSync(workflowDir, { recursive: true });
    this.stateFile = path.join(workflowDir, 'state.json');
    this.state = this.loadState();
  }

  private loadState(): WorkflowState {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        return JSON.parse(raw) as WorkflowState;
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { original_request: '', refined_request: '', subtasks: [] };
        }
        // Corrupt file — back it up and start fresh
        const backupPath = `${this.stateFile}.corrupt.${Date.now()}`;
        try { fs.renameSync(this.stateFile, backupPath); } catch {}
        getLogger().warn(`State file was corrupt; backed up to ${backupPath}`);
      }
    }
    return { original_request: '', refined_request: '', subtasks: [] };
  }

  saveState(): void {
    const data = JSON.stringify(this.state, null, 2);
    const tmpPath = `${this.stateFile}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      // Re-ensure the directory exists — it may have been removed after construction
      // (e.g. git clean, fresh project, or manual deletion).
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, this.stateFile);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }

  getState(): WorkflowState {
    return structuredClone(this.state);
  }

  initWorkflow(request: string): void {
    this.state = { original_request: request, refined_request: '', subtasks: [] };
    this.saveState();
  }

  updateRefinedRequest(refined: string): void {
    this.state.refined_request = refined;
    this.saveState();
  }

  setSubtasks(subtasks: (Partial<Subtask> & { id: string; description: string })[]): void {
    this.state.subtasks = subtasks.map((t) => ({
      ...t,
      status: 'pending' as const,
      tests_written: false,
      code_implemented: false,
      attempts: 0,
    }));
    this.saveState();
  }

  getNextPendingTask(): Subtask | undefined {
    return this.state.subtasks.find((t) => t.status === 'pending');
  }

  getSubtask(id: string): Subtask | undefined {
    return this.state.subtasks.find((t) => t.id === id);
  }

  updateSubtask(id: string, updates: Partial<Subtask>): void {
    const task = this.state.subtasks.find((t) => t.id === id);
    if (task) {
      Object.assign(task, updates);
      this.saveState();
    } else {
      getLogger().warn(`updateSubtask: unknown task id "${id}"`);
    }
  }

  resetInterruptedTasks(): number {
    let count = 0;
    for (const task of this.state.subtasks) {
      if (task.status === 'in_progress') {
        task.status = 'pending';
        count++;
      }
    }
    if (count > 0) this.saveState();
    return count;
  }

  resetFailedTasks(): number {
    let count = 0;
    for (const task of this.state.subtasks) {
      if (task.status === 'failed') {
        task.status = 'pending';
        task.attempts = 0;
        task.phase = undefined;
        task.feedback = undefined;
        count++;
      }
    }
    if (count > 0) this.saveState();
    return count;
  }

  /**
   * Like resetFailedTasks but intentionally keeps `feedback` so the implementer
   * can see what the reviewer said in the previous run.
   */
  resumeFailedTasks(): number {
    let count = 0;
    for (const task of this.state.subtasks) {
      if (task.status === 'failed') {
        task.status = 'pending';
        task.attempts = 0;
        task.phase = undefined;
        // task.feedback intentionally preserved
        count++;
      }
    }
    if (count > 0) this.saveState();
    return count;
  }

  hasWorkflow(): boolean {
    return this.state.subtasks.length > 0;
  }

  getSummary(): { total: number; pending: number; completed: number; failed: number; inProgress: number } {
    const subtasks = this.state.subtasks;
    return {
      total: subtasks.length,
      pending: subtasks.filter((t) => t.status === 'pending').length,
      completed: subtasks.filter((t) => t.status === 'completed').length,
      failed: subtasks.filter((t) => t.status === 'failed').length,
      inProgress: subtasks.filter((t) => t.status === 'in_progress').length,
    };
  }
}
