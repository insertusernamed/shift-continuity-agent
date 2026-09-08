import type { ShiftHandoff, ShiftState } from "./types.ts";

/**
 * The handoff is the product: only unresolved work, unresolved problems,
 * conflicts, and human-decision-required items. Resolved history is
 * summarized by counts, never repeated item by item.
 */
export function buildHandoff(state: ShiftState): ShiftHandoff {
  const requiresAction = state.items
    .filter((i) => i.status === "open")
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));

  const requiresHumanReview = state.items
    .filter((i) => i.status === "conflicted")
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));

  return {
    shiftId: state.shift.id,
    shiftName: state.shift.name,
    requiresAction,
    requiresHumanReview,
    resolvedDuringShiftCount: state.items.filter((i) => i.status === "resolved").length,
    decidedDuringShiftCount: state.items.filter((i) => i.status === "decided").length,
  };
}
