import { CheckResult, type CheckResult as TCheckResult } from "../domain/reports.js";
import type { CheckDefinition } from "../domain/project.js";

/**
 * VERIFICATION CHECK EXECUTION - DELIBERATELY DISABLED
 *
 * `project.checks` models the commands a project declares for verifying an
 * implementation (`npm test`, `tsc --noEmit`, and so on). This phase RECORDS
 * them as evidence and REFUSES to run them.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DISABLED RATHER THAN IMPLEMENTED
 * ---------------------------------------------------------------------------
 * Running a declared check means executing a command string. A command string
 * is not an argv array: `npm test` has to be split, and splitting it correctly
 * for `npm run test -- --grep "a b"` means either a shell (which reintroduces
 * exactly the arbitrary execution Phase 1+2 excluded) or a parser whose bugs
 * become security bugs.
 *
 * More importantly: nothing needs it yet. Checks exist to verify an
 * implementation, and this phase has NO implementation capability - there is
 * nothing to verify. Turning on process execution now would widen the
 * capability boundary to make a feature look complete, which is precisely what
 * the phase brief forbids.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FUTURE IMPLEMENTATION MUST CARRY
 * ---------------------------------------------------------------------------
 * The interface below is the seam. An enabled runner must have ALL of:
 *
 *   - an explicit allowlist of executables (not command strings)
 *   - argv arrays, `shell: false` - no string ever parsed by a shell
 *   - commands declared in project.json only, never model-generated
 *   - cwd contained by the project's FsBoundary
 *   - a wall-clock timeout and an output byte cap
 *   - a built environment, inheriting no credentials (see gitExec.ts safeEnv)
 *   - a static risk classification, gated like any other capability
 *   - tests proving each restriction
 *
 * Until every one of those exists, `enabled` stays false and results carry
 * `executed: false`.
 */
export interface CheckRunner {
  /** False means nothing is executed. Callers must not report checks as run. */
  readonly enabled: boolean;
  run(check: CheckDefinition): Promise<TCheckResult>;
  runAll(checks: readonly CheckDefinition[]): Promise<TCheckResult[]>;
}

export class DisabledCheckRunner implements CheckRunner {
  readonly enabled = false;

  async run(check: CheckDefinition): Promise<TCheckResult> {
    return CheckResult.parse({
      name: check.name,
      command: check.command,
      exitCode: null,
      passed: false,
      executed: false,
      skippedReason:
        "check execution is disabled: the orchestrator has no process-execution " +
        "capability outside read-only git inspection",
      output: "",
    });
  }

  async runAll(checks: readonly CheckDefinition[]): Promise<TCheckResult[]> {
    return Promise.all(checks.map((check) => this.run(check)));
  }
}
