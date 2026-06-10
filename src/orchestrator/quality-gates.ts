import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { execFileAsync, DEFAULT_MAX_BUFFER } from '../utils/exec.js';
import { getTestRunner, getBuildCommand, getLintCommand, type TestMetrics, type CoverageMetrics, type TestResult } from './test-runner.js';

export interface GateResult {
  gate: string;
  passed: boolean;
  output: string;
  blocking: boolean;
}

/** Lifecycle phase of a single gate, reported live via RunQualityGatesOptions.onGate. */
export type GatePhase = 'start' | 'pass' | 'fail';

export interface GateProgress {
  /** Canonical gate id: 'build' | 'typescript' | 'tests' | 'coverage' | 'lint' | 'file-safety'. */
  gate: string;
  phase: GatePhase;
  /** Short human-readable detail — the command on 'start', a metric/summary on 'pass'/'fail'. */
  detail?: string;
}

/** Human label for a gate id, used in live progress lines. */
export function gateLabel(gate: string): string {
  switch (gate) {
    case 'build': return 'build / type-check';
    case 'typescript': return 'type-check (tsc)';
    case 'tests': return 'tests';
    case 'coverage': return 'coverage';
    case 'lint': return 'lint';
    case 'file-safety': return 'file-safety check';
    default: return gate;
  }
}

/**
 * Wall-clock budget for a single test or coverage run. Large suites blow the
 * old 120s budget, so default to 5 minutes. Override per project via
 * package.json `tddConfig.testTimeoutMs` (milliseconds).
 */
const TEST_RUN_TIMEOUT_MS = 300_000;

function getTestTimeoutMs(projectDir: string): number {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    const v = pkg.tddConfig?.testTimeoutMs;
    if (typeof v === 'number' && v > 0) return v;
  } catch { /* fall back to default */ }
  return TEST_RUN_TIMEOUT_MS;
}

// Test and Coverage metrics are now imported from test-runner.ts
export type { TestMetrics, CoverageMetrics };

export interface QualityReport {
  gates: GateResult[];
  allBlockingPassed: boolean;
  testMetrics?: TestMetrics;
  coverageMetrics?: CoverageMetrics;
  /** Absolute path to the full gate report written to .tdd-workflow/logs/ */
  reportPath?: string;
}

/**
 * Extract a normalised set of "error signatures" from a gate's output. Used to
 * compare baseline (pre-implementer) gate failures against post-implementer
 * failures so we can distinguish pre-existing errors from ones the implementer
 * introduced — instead of masking every failure of a gate that was already red.
 *
 * The extractor is gate-aware but conservative: if a gate's output format is
 * unrecognised, it falls back to a generic line-based fingerprint.
 */
export function extractErrorSignatures(gateName: string, output: string): Set<string> {
  if (!output) return new Set();
  const lines = output.split('\n').map(l => l.trimEnd());

  // Per-gate signature extraction. Signatures intentionally OMIT line/column
  // numbers where possible so that purely structural edits (adding imports,
  // re-indenting) don't cause existing errors to look "new".
  switch (gateName) {
    case 'typescript': {
      // Lines like "src/foo.ts(12,34): error TS2345: Argument of type ..."
      const out = new Set<string>();
      for (const l of lines) {
        const m = l.match(/^(.+\.[cm]?[jt]sx?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/);
        if (m) {
          // File + error code + message.
          out.add(`${m[1]}:${m[5]}:${m[6]}`);
        }
      }
      return out;
    }
    case 'tests': {
      // Fingerprint per test CASE, not per file. Otherwise a new failing test
      // in a file that was already red would collapse onto the existing file
      // signature and be masked as pre-existing.
      //
      // Vitest stylish output includes:
      //   " ❯ tests/foo.test.ts > describeBlock > it does X"     (tree line)
      //   "  × it does X  4ms"                                    (assertion marker line)
      //   " FAIL  tests/foo.test.ts > describeBlock > it does X"  (per-case FAIL)
      //   "AssertionError: expected 'x' to equal 'y'"             (stack frame — skipped)
      //
      // We match the FAIL + × / ✖ / ✗ / ❯ forms and normalise any trailing
      // duration (" 4ms") so an identical test that just runs faster/slower
      // isn't seen as new.
      const out = new Set<string>();
      const stripDuration = (s: string) => s.replace(/\s+\d+(?:\.\d+)?\s*m?s\s*$/, '').trim();
      for (const l of lines) {
        const fail = l.match(/^\s*(?:FAIL|×|✖|✗|❯)\s+(.+)$/);
        if (fail) {
          const sig = stripDuration(fail[1]!);
          // Only keep entries that actually name a test (contain ">" for
          // suite>case separator, or a spec-file extension). This filters out
          // summary lines like "❯ Failed Tests 3".
          if (sig.includes(' > ') || /\.(test|spec)\.[cm]?[jt]sx?\b/.test(sig)) {
            out.add(sig);
          }
        }
      }
      return out;
    }
    case 'build': {
      // Build output is heterogeneous: tsc diagnostics, bundler errors
      // (rollup/rolldown MISSING_EXPORT), esbuild errors, and Nx task wrappers.
      // Fingerprint the structured forms (dropping line/col + ANSI + durations)
      // so a shifted line or a slower run isn't seen as a new error.
      const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');
      const out = new Set<string>();
      for (const raw of lines) {
        const l = stripAnsi(raw);
        // tsc: "src/foo.ts(12,34): error TS2345: ..."
        const ts = l.match(/^(.+\.[cm]?[jt]sx?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.+)$/);
        if (ts) { out.add(`${ts[1]}:${ts[4]}:${ts[5]}`); continue; }
        // rollup / rolldown: '"X" is not exported by "Y"' (the type-only re-export trap)
        const exp = l.match(/["']([^"']+)["']\s+is not exported by\s+["']([^"']+)["']/i);
        if (exp) { out.add(`missing-export:${exp[2]}:${exp[1]}`); continue; }
        // esbuild: "src/x.ts:10:5: ERROR: message"
        const esb = l.match(/^(.+?):\d+:\d+: (?:ERROR|error):?\s*(.+)$/);
        if (esb) { out.add(`${esb[1]}:${esb[2]}`); continue; }
      }
      // Fallback: if no structured signature matched but the output clearly
      // errored, fingerprint error/fail lines (minus trailing durations) so a
      // genuine failure isn't mistaken for "no errors".
      if (out.size === 0) {
        for (const raw of lines) {
          const l = stripAnsi(raw).replace(/\s+\d+(?:\.\d+)?\s*m?s\s*$/, '').trim();
          if (l && /error|fail|cannot find|not exported|MISSING_EXPORT/i.test(l)) out.add(l);
        }
      }
      return out;
    }
    case 'lint': {
      // ESLint compact / stylish: "path/to/file:line:col  error  message  rule"
      const out = new Set<string>();
      for (const l of lines) {
        const m = l.match(/^\s*(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/);
        if (m && m[4] === 'error') {
          // File + message + rule (no line/col).
          out.add(`${m[1]}:${m[5]!.trim()}${m[6] ? `:${m[6]}` : ''}`);
        }
      }
      return out;
    }
    case 'lens': {
      // Lens output mixes "[LSP] file: N error(s)" / "[Structural] file: ..."
      // headers with indented lines like "  L42: message". Fingerprint by
      // (file, message) so a shifted line number doesn't fake a new issue.
      const out = new Set<string>();
      let currentFile = '';
      for (const l of lines) {
        const header = l.match(/^\[(LSP|Structural)\]\s+(.+?)(?::\s+\d+ error\(s\))?$/);
        if (header) {
          currentFile = header[2]!.replace(/:$/, '').trim();
          continue;
        }
        const body = l.match(/^\s+(?:L\d+:\s*)?(.+)$/);
        if (body && currentFile && body[1]!.trim()) {
          // Drop "L42:" prefix if any, then key on file + normalised message.
          const msg = body[1]!.trim();
          out.add(`${currentFile}:${msg}`);
        }
      }
      // Fallback: if nothing matched the structured format, treat every
      // non-empty line as a separate signature (defensive for custom Lens builds).
      if (out.size === 0) {
        for (const l of lines) if (l.trim()) out.add(l.trim());
      }
      return out;
    }
    case 'coverage':
      // Coverage doesn't have line-level signatures; callers handle it by
      // comparing pass/fail directly. Return empty so any coverage failure
      // looks like a regression unless the caller short-circuits.
      return new Set();
    case 'file-safety': {
      // file-safety lists unexpected files under a header line. Extract the
      // file paths so a baseline with one unexpected file doesn't silently
      // mask a new unexpected file introduced by the implementer.
      const out = new Set<string>();
      let inList = false;
      for (const l of lines) {
        if (/Unexpected files/i.test(l)) {
          inList = true;
          continue;
        }
        if (inList) {
          const trimmed = l.trim();
          if (!trimmed) continue;
          // Stop if we hit another header-like line (empty block ended).
          if (/^[A-Z][a-z].*:$/.test(trimmed)) break;
          out.add(trimmed);
        }
      }
      return out;
    }
    default: {
      // Unknown gate — fingerprint every non-empty line that mentions "error".
      const out = new Set<string>();
      for (const l of lines) {
        if (/error|fail/i.test(l) && l.trim()) out.add(l.trim());
      }
      return out;
    }
  }
}

/**
 * Compare a gate's current failing output against its baseline output.
 * Returns the set of error signatures that are NEW (present now, absent in
 * baseline). Callers treat a non-empty set as a genuine regression.
 */
export function diffGateFailures(
  gateName: string,
  baselineOutput: string,
  currentOutput: string,
): { newErrors: string[]; baselineCount: number; currentCount: number } {
  const baseline = extractErrorSignatures(gateName, baselineOutput);
  const current = extractErrorSignatures(gateName, currentOutput);
  const newErrors: string[] = [];
  for (const sig of current) {
    if (!baseline.has(sig)) newErrors.push(sig);
  }
  return { newErrors, baselineCount: baseline.size, currentCount: current.size };
}

export interface RunQualityGatesOptions {
  /**
   * When true, run coverage after the tests gate and populate `report.coverageMetrics`
   * regardless of whether `tddConfig.coverageThresholds` is configured. If thresholds
   * are also set, the same coverage run is reused for the threshold gate — no double-run.
   * Use this at workflow start (baseline), during cleanup (planner context), and before
   * the final review.
   */
  collectCoverage?: boolean;
  /**
   * When true, resolve build/lint to their FULL-workspace form (`nx run-many`)
   * instead of the diff-scoped `nx affected`. Use this ONLY for the baseline run
   * at workflow start: `nx affected` against an empty diff lints/builds nothing,
   * so it records no pre-existing failures and any later per-task `affected`
   * failure (which pulls in whole affected projects) looks like a new regression.
   * A full-scope baseline captures the complete pre-existing state so the
   * signature comparison can correctly mask pre-existing issues.
   */
  fullScope?: boolean;
  /**
   * Live progress callback fired as each gate starts and finishes. Lets the
   * orchestrator surface what it's doing during the (often multi-minute) gate
   * sweep between implementation and review rounds, instead of going silent.
   * Best-effort — exceptions thrown by the callback are swallowed.
   */
  onGate?: (progress: GateProgress) => void;
}

/** True when the project opts into blocking coverage via tddConfig.coverageThresholds. */
export function hasCoverageThresholds(projectDir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    return !!pkg.tddConfig?.coverageThresholds;
  } catch {
    return false;
  }
}

/**
 * Run coverage only, returning metrics without running the full gate suite.
 * Returns undefined when no coverage runner/tools are available.
 * Used by the final workflow reviewer to compare against the baseline snapshot.
 */
export async function collectCoverageSnapshot(projectDir: string): Promise<CoverageMetrics | undefined> {
  const runner = getTestRunner(projectDir);
  if (!runner) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    const hasCoverageTools =
      pkg.devDependencies?.['@vitest/coverage-v8'] ||
      pkg.devDependencies?.['@vitest/coverage-istanbul'] ||
      pkg.scripts?.['test:coverage'] ||
      pkg.scripts?.coverage;
    if (!hasCoverageTools) return undefined;
  } catch { return undefined; }
  try {
    const result = await runner.runCoverage(projectDir, getTestTimeoutMs(projectDir));
    return result.coverage;
  } catch {
    return undefined;
  }
}

export async function runQualityGates(projectDir: string, options: RunQualityGatesOptions = {}): Promise<QualityReport> {
  const logger = getLogger();
  const gates: GateResult[] = [];
  let testMetrics: TestMetrics | undefined;
  let coverageMetrics: CoverageMetrics | undefined;

  // Best-effort live progress — never let a misbehaving callback break the sweep.
  const emit = (progress: GateProgress): void => {
    try { options.onGate?.(progress); } catch { /* progress is advisory */ }
  };
  const emitResult = (gate: string, r: GateResult): GateResult => {
    emit({ gate, phase: r.passed ? 'pass' : 'fail' });
    return r;
  };

  // Gate 1: Build / type-check (BLOCKING)
  // A real build is the authoritative type-check: it runs the production
  // tsconfig(s) with strict flags AND the bundler, catching type-only
  // re-export failures (MISSING_EXPORT), declaration emit, and consumer
  // breakage that `tsc --noEmit` against a loose root tsconfig misses. In an
  // Nx workspace getBuildCommand resolves to `nx affected -t build` so the
  // CONSUMERS of a changed lib are built too. We only fall back to a bare
  // `tsc --noEmit` when no build command can be resolved.
  const buildCommand = getBuildCommand(projectDir, options.fullScope);
  if (buildCommand) {
    emit({ gate: 'build', phase: 'start', detail: buildCommand });
    gates.push(emitResult('build', await runGate('build', splitCommand(buildCommand), projectDir, true, 300_000)));
  } else {
    const tsconfigPath = path.join(projectDir, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      emit({ gate: 'typescript', phase: 'start', detail: 'tsc --noEmit' });
      gates.push(emitResult('typescript', await runGate('typescript', ['npx', 'tsc', '--noEmit'], projectDir, true, 60_000)));
    }
  }

  // Gate 2: Tests pass (BLOCKING)
  const runner = getTestRunner(projectDir);
  if (runner) {
    const pkgJsonPath = path.join(projectDir, 'package.json');
    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch (err) {
      logger.warn(`Failed to parse ${pkgJsonPath}: ${(err as Error).message}`);
    }

    // Gate 2a: Tests pass — always run with the plain test command so this gate
    // uses the exact same command the implementer agent will use. Running with
    // --coverage here causes false failures: coverage instrumentation adds
    // ~20-40% overhead (integration tests can tip over the timeout) and can
    // produce different pass/fail results than a plain test run.
    emit({ gate: 'tests', phase: 'start' });
    const testResult = await runner.runTests(projectDir, getTestTimeoutMs(projectDir));

    gates.push({
      gate: 'tests',
      passed: testResult.passed,
      output: testResult.output,
      blocking: true,
    });

    testMetrics = testResult.metrics;
    emit({
      gate: 'tests',
      phase: testResult.passed ? 'pass' : 'fail',
      detail: testMetrics ? `${testMetrics.passed}/${testMetrics.total} passed` : undefined,
    });

    // Gate 2b: Coverage — run when the caller needs a snapshot (collectCoverage:true)
    // or when the project has explicit thresholds configured. A single coverage run
    // serves both purposes so we never run tests twice for the same gate check.
    const needsCoverageRun = options.collectCoverage || !!pkg.tddConfig?.coverageThresholds;
    if (needsCoverageRun) {
      emit({ gate: 'coverage', phase: 'start' });
      try {
        const coverageResult = await runner.runCoverage(projectDir, getTestTimeoutMs(projectDir));
        coverageMetrics = coverageResult.coverage;
      } catch (err) {
        logger.warn(`Coverage run failed (non-fatal): ${(err as Error).message}`);
      }

      if (pkg.tddConfig?.coverageThresholds && coverageMetrics) {
        const thresholds = pkg.tddConfig.coverageThresholds;
        const coveragePass = checkCoverageThresholds(coverageMetrics, thresholds);
        gates.push({
          gate: 'coverage',
          passed: coveragePass.passed,
          output: coveragePass.message,
          blocking: true,
        });
        emit({ gate: 'coverage', phase: coveragePass.passed ? 'pass' : 'fail', detail: `${coverageMetrics.lines}% lines` });
      } else {
        // Snapshot-only run (no blocking threshold gate) — still report it finished.
        emit({ gate: 'coverage', phase: 'pass', detail: coverageMetrics ? `${coverageMetrics.lines}% lines` : 'collected' });
      }
    }
  } else {
    logger.warn('No test runner detected — skipping test gate');
  }

  // Gate 3: Lint (BLOCKING — but scoped to NEW errors via the baseline diff in
  // the executor, so a project's pre-existing lint debt never traps the loop).
  // Lint is the only gate that catches dependency-hygiene (undeclared deps) and
  // broken-config failures. getLintCommand resolves an Nx/script/eslint command
  // and is flat-config-aware (omits the dead `--ext` flag under eslint.config.*).
  const lintCommand = getLintCommand(projectDir, options.fullScope);
  if (lintCommand) {
    emit({ gate: 'lint', phase: 'start', detail: lintCommand });
    gates.push(emitResult('lint', await runGate('lint', splitCommand(lintCommand), projectDir, true, 120_000)));
  }

  // Gate 4: File safety (BLOCKING)
  emit({ gate: 'file-safety', phase: 'start' });
  gates.push(emitResult('file-safety', await checkFileSafety(projectDir)));

  const allBlockingPassed = gates.filter((g) => g.blocking).every((g) => g.passed);
  logger.info(`Quality gates: ${gates.filter((g) => g.passed).length}/${gates.length} passed (blocking: ${allBlockingPassed})`);

  if (testMetrics) {
    logger.info(`Tests: ${testMetrics.passed}/${testMetrics.total} passed, ${testMetrics.failed} failed, ${testMetrics.skipped} skipped`);
  }
  if (coverageMetrics) {
    logger.info(`Coverage: lines=${coverageMetrics.lines}% branches=${coverageMetrics.branches}% functions=${coverageMetrics.functions}%`);
  }

  // Persist full gate output to disk so agents can read the complete report
  // when the truncated version embedded in the prompt isn't enough.
  let reportPath: string | undefined;
  try {
    const logsDir = path.join(projectDir, '.tdd-workflow', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    reportPath = path.join(logsDir, `gate-report-${timestamp}.log`);
    const lines: string[] = [`Gate report — ${new Date().toISOString()}`, ''];
    for (const g of gates) {
      const status = g.passed ? 'PASS' : (g.blocking ? 'FAIL (BLOCKING)' : 'FAIL (warning)');
      lines.push(`${'─'.repeat(60)}`, `[${g.gate.toUpperCase()}] ${status}`, g.output, '');
    }
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
    logger.info(`Gate report written to ${reportPath}`);
  } catch (err) {
    logger.warn(`Could not write gate report: ${(err as Error).message}`);
    reportPath = undefined;
  }

  return { gates, allBlockingPassed, testMetrics, coverageMetrics, reportPath };
}

/**
 * Split a resolved command string (e.g. "npx nx affected -t build") into the
 * [program, ...args] tuple runGate expects. We deliberately split on whitespace
 * rather than going through a shell so execFile keeps its no-shell injection
 * safety — the resolved commands never need shell features (pipes, globs, etc.).
 */
export function splitCommand(cmd: string): [string, ...string[]] {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  const [program, ...args] = parts;
  return [program ?? '', ...args];
}

/**
 * Run a quality gate command.
 * Accepts a command as [program, ...args] to avoid shell injection —
 * execFile does not spawn a shell so arguments are passed directly.
 *
 * Timeout handling is explicit: when execFile fires the timeout, Node sends
 * SIGTERM to the child and returns the partial output that was captured so
 * far. We detect that case (killed=true or signal='SIGTERM') and prepend a
 * clear marker to the output — otherwise downstream code (the baseline
 * signature diff, the reviewer prompt) sees truncated tsc/vitest output
 * and treats it as a normal failure, producing misleading "0 tests found"
 * style feedback.
 */
async function runGate(
  name: string,
  command: [string, ...string[]],
  cwd: string,
  blocking: boolean,
  timeoutMs: number
): Promise<GateResult> {
  const logger = getLogger();
  const [program, ...args] = command;
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });
    logger.info(`Gate '${name}' PASSED`);
    return { gate: name, passed: true, output: (stdout + '\n' + stderr).trim(), blocking };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string; code?: number };
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    let output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    if (timedOut) {
      output = `[TIMEOUT after ${timeoutMs / 1000}s — output below is partial and may be truncated mid-line]\n${output}`;
      logger.warn(`Gate '${name}' TIMED OUT after ${timeoutMs / 1000}s`);
    } else {
      logger.info(`Gate '${name}' FAILED: ${output.substring(0, 200)}`);
    }
    return { gate: name, passed: false, output, blocking };
  }
}

/**
 * Check metrics against thresholds
 */
function checkCoverageThresholds(metrics: CoverageMetrics, thresholds: Partial<CoverageMetrics>): { passed: boolean; message: string } {
  const failures: string[] = [];
  if (thresholds.lines && metrics.lines < thresholds.lines) failures.push(`Lines: ${metrics.lines}% < ${thresholds.lines}%`);
  if (thresholds.functions && metrics.functions < thresholds.functions) failures.push(`Functions: ${metrics.functions}% < ${thresholds.functions}%`);
  if (thresholds.branches && metrics.branches < thresholds.branches) failures.push(`Branches: ${metrics.branches}% < ${thresholds.branches}%`);
  if (thresholds.statements && metrics.statements < thresholds.statements) failures.push(`Statements: ${metrics.statements}% < ${thresholds.statements}%`);

  if (failures.length > 0) {
    return { passed: false, message: `Coverage thresholds NOT met:\n${failures.join('\n')}` };
  }
  return { passed: true, message: 'All coverage thresholds met.' };
}

/**
 * Controls what happens when the Lens gate itself crashes (e.g. lens-bridge
 * is not installed on this machine).
 *
 * - 'fail-closed'  (default): a crash is treated as a gate failure.
 *                  Use this in CI and production environments.
 * - 'fail-open':   a crash is treated as a pass (old behaviour).
 *                  Set LENS_FAIL_POLICY=fail-open on developer machines where
 *                  Lens is not installed and you do not want to block work.
 *
 * The choice is read from the LENS_FAIL_POLICY environment variable so it is
 * visible in logs and auditable, rather than being a silent hidden default.
 */
export type LensFailPolicy = 'fail-closed' | 'fail-open';

export function getLensFailPolicy(): LensFailPolicy {
  const raw = process.env['LENS_FAIL_POLICY'];
  if (raw === 'fail-open') return 'fail-open';
  return 'fail-closed'; // secure default
}

/**
 * Run lens analysis and return a human-readable issues string.
 * Empty string means no issues found.
 * Used by the executor to pass before/after context to the reviewer.
 */
export async function runLensAnalysis(projectDir: string): Promise<string> {
  const result = await runLensGate(projectDir);
  if (result.passed) return '';
  return result.output;
}

/**
 * Runs pi-lens analysis as a quality gate.
 * Leverages LSP diagnostics and structural bug patterns.
 */
async function runLensGate(projectDir: string): Promise<GateResult> {
  const logger = getLogger();
  try {
    // Use a variable so esbuild cannot inline this module — it must remain a
    // runtime dynamic import so the pre-built lens-bridge.js (with pi-lens
    // clients bundled inside) is loaded from the same directory as this file.
    // A literal './lens-bridge.js' would be inlined by esbuild, losing the
    // pre-bundled pi-lens clients and breaking the module resolution.
    // @ts-ignore
    const bridgePath = './lens-bridge.js';
    // @ts-ignore
    const { getLensClients } = await import(bridgePath);
    const { TypeScriptClient, AstGrepClient } = await getLensClients();

    const tsClient = new TypeScriptClient();
    const agClient = new AstGrepClient();

    let output = '';
    const issues: string[] = [];

    // 1. LSP Diagnostics (Deep Type Checks)
    // Scan all src and test files
    const files = await getSourceFiles(projectDir);
    for (const file of files) {
      if (tsClient.isTypeScriptFile(file)) {
        const diags = tsClient.getDiagnostics(file);
        const errors = diags.filter((d: any) => d.severity === 1);
        if (errors.length > 0) {
          issues.push(`[LSP] ${path.relative(projectDir, file)}: ${errors.length} error(s)`);
          errors.slice(0, 3).forEach((e: any) => {
            issues.push(`  L${e.range.start.line + 1}: ${e.message}`);
          });
        }
      }
    }

    // 2. Structural Analysis (Bug Patterns)
    if (await agClient.ensureAvailable()) {
      for (const file of files) {
        const structuralDiags = agClient.scanFile(file);
        const blockingStyles = structuralDiags.filter((d: any) => d.severity === 'error');
        if (blockingStyles.length > 0) {
          const report = agClient.formatDiagnostics(blockingStyles);
          issues.push(`[Structural] ${path.relative(projectDir, file)}:\n${report}`);
        }
      }
    }

    const passed = issues.length === 0;
    output = passed ? 'Lens analysis passed. No structural or type blockers found.' : issues.join('\n');

    return {
      gate: 'lens',
      passed,
      output,
      blocking: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Lens gate crashed: ${errMsg}`);

    const policy = getLensFailPolicy();
    const passed = policy === 'fail-open';
    const policyLabel = policy === 'fail-open'
      ? 'fail-open policy: treating as passed'
      : 'fail-closed policy: treating as failed';

    return {
      gate: 'lens',
      passed,
      output: `Lens analysis failed to run (${policyLabel}): ${errMsg}`,
      blocking: true,
    };
  }
}

/**
 * Helper to get source files for analysis
 */
async function getSourceFiles(projectDir: string): Promise<string[]> {
  // Build / generated output directories — feeding these to the TS LSP crashes
  // because they contain bundled JS without matching tsconfig sources.
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'lib', 'coverage', 'tmp',
    'build', 'out', 'storybook-static',
    '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
    '.vite', '.vercel', '.netlify', '.output',
  ]);
  const walk = (dir: string): string[] => {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        if (SKIP_DIRS.has(file)) continue;
        results = results.concat(walk(fullPath));
      } else {
        if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.tsx') || file.endsWith('.jsx')) {
          results.push(fullPath);
        }
      }
    }
    return results;
  };
  return walk(projectDir);
}

// ─── File Safety ─────────────────────────────────────────────────

/**
 * Built-in prefixes that are always allowed in file-safety checks.
 * Projects can extend this list via package.json#tddConfig.fileSafetyAllowlist.
 *
 * Each entry is matched as a path prefix (e.g. "docs/" matches "docs/foo/bar.md").
 * Entries without a trailing slash are matched exactly as a prefix, so "docs"
 * would also match "docs-extra/". Always use a trailing slash for directory entries.
 */
const BUILTIN_SAFE_PREFIXES = [
  'src/',
  'tests/',
  'test/',
  '__tests__/',
  'e2e/',
  'lib/',
  'libs/',
  'apps/',
  'packages/',
  'docs/',
  'scripts/',
  'config/',
  'public/',
  'static/',
  'assets/',
  'styles/',
  'schemas/',
  'migrations/',
  'prisma/',
  'coverage/',
  '.github/',
  '.vscode/',
  '.pi-lens/',
  '.tdd-workflow/',
];

const BUILTIN_SAFE_PATTERNS = [
  // Package manifests / lockfiles
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|pnpm-workspace\.yaml)/,
  // TS / lint / formatter configs
  /^(tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|vitest\.config|vitest\.workspace|jest\.config|prettier\.config|\.prettierrc[^/]*)/,
  // Common root dotfiles
  /^\.(gitignore|gitattributes|npmignore|npmrc|prettierignore|eslintignore|editorconfig|nvmrc|node-version|dockerignore|env\.example)$/,
  // Framework / monorepo / bundler configs at repo root
  /^(turbo\.json|nx\.json|project\.json|lerna\.json|rush\.json|workspace\.json)$/,
  /^(vite\.config|rollup\.config|webpack\.config|esbuild\.config|tsup\.config|babel\.config|\.babelrc)/,
  /^(tailwind\.config|postcss\.config|next\.config|nuxt\.config|svelte\.config|astro\.config|remix\.config|gatsby-config)/,
  // Docker
  /^(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.docker\/)/,
  // Repo-level docs (allow any *.md at the root, and common root text files)
  /^[^/]+\.(md|mdx|txt|rst)$/i,
  /^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AUTHORS|NOTICE)(\.[^/]+)?$/i,
];

export function loadFileSafetyAllowlist(projectDir: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    const extra: unknown = pkg?.tddConfig?.fileSafetyAllowlist;
    if (Array.isArray(extra)) {
      return (extra as unknown[]).filter((e): e is string => typeof e === 'string');
    }
  } catch {
    // No package.json or no tddConfig — fine
  }
  return [];
}

async function checkFileSafety(projectDir: string): Promise<GateResult> {
  try {
    let stdout: string;

    try {
      // Try to get files changed since last commit
      const result = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: projectDir,
        timeout: 10_000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      stdout = result.stdout;
    } catch {
      // No commits yet or not a git repo — list untracked files instead
      const result = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: projectDir,
        timeout: 10_000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      stdout = result.stdout;
    }

    const extraPrefixes = loadFileSafetyAllowlist(projectDir);
    const allPrefixes = [...BUILTIN_SAFE_PREFIXES, ...extraPrefixes];

    const unexpectedFiles = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => {
        if (BUILTIN_SAFE_PATTERNS.some(re => re.test(f))) return false;
        return !allPrefixes.some(prefix => f.startsWith(prefix));
      });

    return {
      gate: 'file-safety',
      passed: unexpectedFiles.length === 0,
      output: unexpectedFiles.length > 0
        ? `Unexpected files outside standard directories:\n${unexpectedFiles.join('\n')}`
        : 'All files in expected locations',
      blocking: true,
    };
  } catch {
    return { gate: 'file-safety', passed: true, output: 'Git not available — skipped', blocking: true };
  }
}

// ─── Formatting ──────────────────────────────────────────────────

export function formatGateFailures(report: QualityReport): string {
  const failed = report.gates.filter((g) => !g.passed);
  if (failed.length === 0) return 'All gates passed.';

  return failed
    .map((g) => `[${g.gate.toUpperCase()} ${g.blocking ? 'BLOCKING' : 'WARNING'}]\n${g.output}`)
    .join('\n\n');
}
