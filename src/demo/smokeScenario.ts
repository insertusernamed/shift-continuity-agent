import type { Shift, ShiftState } from "../domain/types.ts";
import type { AsyncShiftStore } from "../store/dynamoDbStore.ts";
import { seedCoreDemoShiftInto } from "./demoScenario.ts";

/**
 * Isolation for the remote AgentCore smoke.
 *
 * Durable persistence is a feature, not a nuisance: it is exactly why a second
 * smoke run must not reuse the first run's shift. Instead of clearing the table
 * (which would destroy real history and prove nothing), each run seeds its own
 * uniquely named shift from the canonical scenario and targets that shift on
 * every request. Prior runs then cannot contaminate later ones, and a real
 * deployment keeps every run's history.
 *
 * The events come from `seedCoreDemoShiftInto`, so there is still exactly one
 * definition of the scenario.
 */

/** Namespaced so old smoke shifts are identifiable and safe to clean up later. */
export const REMOTE_SMOKE_PREFIX = "remote-smoke";

export function remoteSmokeShiftName(runId: string): string {
  return `${REMOTE_SMOKE_PREFIX}-${runId}`;
}

/**
 * Create and seed a fresh shift for one smoke run. Idempotent per run id only
 * in the sense that each call creates a new shift — runs are identified by
 * `runId`, so a run never reuses another run's state.
 */
export async function seedRemoteSmokeShift(
  store: AsyncShiftStore,
  runId: string,
  startedAt?: string,
): Promise<Shift> {
  return seedCoreDemoShiftInto(store, {
    name: remoteSmokeShiftName(runId),
    ...(startedAt ? { startedAt } : {}),
  });
}

/**
 * The state a smoke run must observe before any assertion runs. Reporting drift
 * here as a *setup* problem keeps a stale/shared shift from masquerading as a
 * model or domain failure downstream.
 */
export function smokePreconditionProblems(state: ShiftState): string[] {
  const problems: string[] = [];
  const item = (canonicalSubject: string) =>
    state.items.find((candidate) => candidate.canonicalSubject === canonicalSubject);

  const freezer = item("freezer inspection");
  if (freezer?.status !== "open") {
    problems.push(`freezer inspection should be open, found ${freezer?.status ?? "(missing)"}`);
  }

  const d104 = item("d104");
  if (d104?.status !== "conflicted") {
    problems.push(`damaged case D104 should be conflicted, found ${d104?.status ?? "(missing)"}`);
  }
  // Canonical values (see claims.ts): "send to claims" → claims, "discarded" → discard.
  const claims = new Set((d104?.claims ?? []).map((claim) => claim.canonicalValue));
  if (claims.size !== 2 || !claims.has("claims") || !claims.has("discard")) {
    problems.push(
      `damaged case D104 should carry the conflicting claims claims/discard, found ${[...claims].join(" / ") || "(none)"}`,
    );
  }
  if (d104?.decision) {
    problems.push(`damaged case D104 should be undecided, found ${d104.decision.canonicalValue}`);
  }

  return problems;
}
