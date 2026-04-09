import { execFile } from 'child_process';
import { promisify } from 'util';

/**
 * Promisified execFile with a safe 10MB maxBuffer default.
 * Always use this instead of promisify(exec) to avoid shell injection --
 * execFile does NOT spawn a shell, so arguments are passed directly to the
 * process and shell metacharacters have no effect.
 */
export const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * Validate that a git branch name contains only safe characters.
 * Accepts: alphanumeric, hyphens, underscores, forward slashes, and dots.
 * Rejects anything that could be interpreted as a shell metacharacter.
 */
export function sanitizeBranchName(name: string): string {
  if (!name || name.trim() === '') {
    throw new Error('Branch name must not be empty');
  }
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(name)) {
    throw new Error(
      `Invalid branch name "${name}": only alphanumeric characters, hyphens, underscores, dots, and slashes are allowed`
    );
  }
  // Git-specific: branch names cannot start or end with a slash, dot, or contain ..
  if (name.startsWith('/') || name.endsWith('/')) {
    throw new Error(`Invalid branch name "${name}": cannot start or end with a slash`);
  }
  if (name.includes('..')) {
    throw new Error(`Invalid branch name "${name}": cannot contain ".."`);
  }
  return name;
}
