/**
 * Build metadata for the running plugin.
 *
 * The three `__TDD_*__` identifiers are replaced with string literals by esbuild
 * `--define` at bundle time (see scripts/bundle.mjs). When running from source or
 * under tests — where no bundling happens — they are never declared as real
 * bindings, so `typeof` reports `'undefined'` and we fall back to dev markers.
 * `typeof` on an undeclared identifier is the one safe form (a bare reference
 * would throw), which is why each accessor is guarded that way.
 */
declare const __TDD_VERSION__: string | undefined;
declare const __TDD_GIT_SHA__: string | undefined;
declare const __TDD_BUILT_AT__: string | undefined;

export const VERSION: string =
  typeof __TDD_VERSION__ !== 'undefined' ? __TDD_VERSION__ : 'dev';
export const GIT_SHA: string =
  typeof __TDD_GIT_SHA__ !== 'undefined' ? __TDD_GIT_SHA__ : 'source';
export const BUILT_AT: string =
  typeof __TDD_BUILT_AT__ !== 'undefined' ? __TDD_BUILT_AT__ : '';

/**
 * One-line build identifier, e.g.
 *   tdd-workflow 2.1.0 (9091d6b, built 2026-06-09T20:14Z)
 * When unbundled it degrades to `tdd-workflow dev (source)`.
 */
export function versionString(): string {
  const builtAt = BUILT_AT ? `, built ${BUILT_AT}` : '';
  return `tdd-workflow ${VERSION} (${GIT_SHA}${builtAt})`;
}
