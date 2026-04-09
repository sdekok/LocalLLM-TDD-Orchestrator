import * as path from 'path';

/**
 * Resolves `userInput` relative to `baseDir` and throws if the result
 * would escape `baseDir` (path traversal prevention).
 *
 * @param baseDir   Trusted absolute directory that acts as the containment root.
 * @param userInput Untrusted path segment supplied by a caller.
 * @returns The resolved absolute path, guaranteed to be inside `baseDir`.
 * @throws Error if the resolved path escapes `baseDir`.
 */
export function resolveContainedPath(baseDir: string, userInput: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, userInput);

  // Use `resolvedBase + sep` to avoid false positives where
  // base = /foo and resolved = /foobar (different directory).
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(
      `Path traversal detected: "${userInput}" escapes base directory "${resolvedBase}"`
    );
  }

  return resolved;
}
