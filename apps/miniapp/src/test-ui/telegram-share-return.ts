/**
 * Per-attempt latch for native Telegram Share return.
 * Decides when the TEST UI may dispatch CREATE_BAN.SHARE_RETURNED once.
 * Delivery signals stay diagnostic-only and never complete the attempt.
 */

const ENTERED = new Set(["deactivated", "document.visibilitychange:hidden"]);
const RETURNED = new Set(["activated", "document.visibilitychange:visible"]);

type AttemptPhase = "armed" | "entered" | "completed";

export type ShareReturnDecision = Readonly<{
  shareAttemptId: string | null;
  dispatch: boolean;
}>;

const NONE: ShareReturnDecision = { shareAttemptId: null, dispatch: false };

export type ShareReturnLatch = Readonly<{
  arm: (shareAttemptId: string) => void;
  observe: (signal: string) => ShareReturnDecision;
  failOpen: (shareAttemptId: string) => ShareReturnDecision;
}>;

export function createShareReturnLatch(): ShareReturnLatch {
  const phase = new Map<string, AttemptPhase>();
  let current: string | null = null;

  function decision(shareAttemptId: string | null, dispatch: boolean): ShareReturnDecision {
    return { shareAttemptId, dispatch };
  }

  return {
    arm(shareAttemptId: string) {
      if (phase.get(shareAttemptId) === "completed") {
        return;
      }
      current = shareAttemptId;
      if (!phase.has(shareAttemptId)) {
        phase.set(shareAttemptId, "armed");
      }
    },
    observe(signal: string): ShareReturnDecision {
      if (!current) {
        return NONE;
      }
      const state = phase.get(current);
      if (state === undefined || state === "completed") {
        return decision(current, false);
      }
      if (state === "armed" && ENTERED.has(signal)) {
        phase.set(current, "entered");
        return decision(current, false);
      }
      if (state === "entered" && RETURNED.has(signal)) {
        phase.set(current, "completed");
        return decision(current, true);
      }
      return decision(current, false);
    },
    failOpen(shareAttemptId: string): ShareReturnDecision {
      if (phase.get(shareAttemptId) === "completed") {
        return decision(shareAttemptId, false);
      }
      phase.set(shareAttemptId, "completed");
      return decision(shareAttemptId, true);
    },
  };
}
