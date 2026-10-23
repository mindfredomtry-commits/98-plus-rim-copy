/**
 * Per-attempt latch for template-share completion.
 * CREATE_BAN.SHARE_RETURNED is dispatched once after the share attempt,
 * without waiting for a Telegram callback or visibility transition.
 * Callback and visibility signals stay diagnostic. A late signal cannot
 * dispatch a second E-66 for the same attempt.
 */

const SHARE_PENDING = "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING";
const SHARE_RETURNED = "CREATE_BAN.SHARE_RETURNED";

const ENTERED = new Set(["deactivated", "document.visibilitychange:hidden"]);
const RETURNED = new Set(["activated", "document.visibilitychange:visible"]);

type AttemptPhase = "armed" | "entered" | "completing" | "invoked" | "completed";

export type ShareReturnDecision = Readonly<{
  shareAttemptId: string | null;
  dispatch: boolean;
}>;

const NONE: ShareReturnDecision = { shareAttemptId: null, dispatch: false };

export type ShareReturnLatch = Readonly<{
  arm: (shareAttemptId: string) => void;
  observe: (signal: string) => ShareReturnDecision;
  failOpen: (shareAttemptId: string) => ShareReturnDecision;
  claim: (shareAttemptId: string) => "begin" | "retry" | "done";
  abandon: (shareAttemptId: string) => void;
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
    claim(shareAttemptId: string) {
      const state = phase.get(shareAttemptId);
      if (state === "completed" || state === "completing") {
        return "done";
      }
      current = shareAttemptId;
      if (state === "invoked") {
        phase.set(shareAttemptId, "completing");
        return "retry";
      }
      phase.set(shareAttemptId, "completing");
      return "begin";
    },
    abandon(shareAttemptId: string) {
      if (phase.get(shareAttemptId) === "completing") {
        phase.set(shareAttemptId, "invoked");
      }
    },
  };
}

export type ShareCompletionNotice = Readonly<{
  code: string;
  message: string;
}>;

export type ForbidShareCompletionPlan = Readonly<{
  invokeShare: boolean;
  preparedMessageId: string | null;
  shareAttemptId: string | null;
  dispatchEvent: typeof SHARE_RETURNED | null;
  notice: ShareCompletionNotice | null;
}>;

const PREPARE_MISSING: ShareCompletionNotice = {
  code: "TELEGRAM_SHARE_PREPARE_MISSING",
  message:
    "preparedMessageId missing — savePreparedInlineMessage did not succeed. The Ban stays created.",
};

const SHARE_UNAVAILABLE: ShareCompletionNotice = {
  code: "TELEGRAM_SHARE_UNAVAILABLE",
  message: "Telegram.WebApp.shareMessage is unavailable in this runtime. The Ban stays created.",
};

const SHARE_OPEN_FAILED: ShareCompletionNotice = {
  code: "TELEGRAM_SHARE_OPEN_FAILED",
  message: "Telegram.WebApp.shareMessage threw. The Ban stays created.",
};

export function planForbidShareCompletion(input: {
  controlState: string | null;
  shareAttemptId: string | null;
  preparedMessageId: string | null;
  shareMessageAvailable: boolean;
}): ForbidShareCompletionPlan {
  const shareAttemptId = input.shareAttemptId?.trim() ? input.shareAttemptId.trim() : null;
  if (input.controlState !== SHARE_PENDING || !shareAttemptId) {
    return {
      invokeShare: false,
      preparedMessageId: null,
      shareAttemptId: null,
      dispatchEvent: null,
      notice: null,
    };
  }
  const preparedMessageId = input.preparedMessageId?.trim() ? input.preparedMessageId.trim() : null;
  if (preparedMessageId && input.shareMessageAvailable) {
    return {
      invokeShare: true,
      preparedMessageId,
      shareAttemptId,
      dispatchEvent: SHARE_RETURNED,
      notice: null,
    };
  }
  return {
    invokeShare: false,
    preparedMessageId: null,
    shareAttemptId,
    dispatchEvent: SHARE_RETURNED,
    notice: preparedMessageId ? SHARE_UNAVAILABLE : PREPARE_MISSING,
  };
}

export type CompleteForbidShareInput = Readonly<{
  controlState: string | null;
  shareAttemptId: string | null;
  preparedMessageId: string | null;
  shareMessageAvailable: boolean;
  latch: ShareReturnLatch;
  invokeShareMessage: (preparedMessageId: string) => void;
  dispatchReturned: (shareAttemptId: string) => Promise<void>;
  onNotice?: (notice: ShareCompletionNotice) => void;
}>;

/**
 * Invoke Telegram Share when a prepared id is available, then dispatch E-66 once.
 * The shareMessage callback and visibility events are not awaited.
 */
export async function completeForbidShare(
  input: CompleteForbidShareInput,
): Promise<"DISPATCHED" | "SKIPPED" | "ALREADY_COMPLETED"> {
  const plan = planForbidShareCompletion(input);
  if (plan.dispatchEvent !== SHARE_RETURNED || !plan.shareAttemptId) {
    return "SKIPPED";
  }
  const claim = input.latch.claim(plan.shareAttemptId);
  if (claim === "done") {
    return "ALREADY_COMPLETED";
  }
  let notice = plan.notice;
  if (claim === "begin" && plan.invokeShare && plan.preparedMessageId) {
    try {
      input.invokeShareMessage(plan.preparedMessageId);
    } catch {
      notice = SHARE_OPEN_FAILED;
    }
  }
  try {
    await input.dispatchReturned(plan.shareAttemptId);
  } catch (error) {
    input.latch.abandon(plan.shareAttemptId);
    throw error;
  }
  input.latch.failOpen(plan.shareAttemptId);
  if (notice && claim === "begin") {
    input.onNotice?.(notice);
  }
  return "DISPATCHED";
}
