/**
 * TEST UI observation log for native Telegram share signals.
 * Records order only. Does not dispatch Product events, mint a Ban, or change control state.
 */

export type ShareSignalEntry = Readonly<{
  order: number;
  atMs: number;
  iso: string;
  shareAttemptId: string;
  signal: string;
}>;

const NO_ATTEMPT = "(none)";

export type ShareSignalLog = Readonly<{
  beginAttempt: (shareAttemptId: string) => void;
  record: (signal: string) => void;
  entries: () => readonly ShareSignalEntry[];
  format: () => string;
}>;

export function createShareSignalLog(now: () => number = () => Date.now()): ShareSignalLog {
  const entries: ShareSignalEntry[] = [];
  let shareAttemptId = NO_ATTEMPT;

  function record(signal: string): void {
    const atMs = now();
    entries.push({
      order: entries.length + 1,
      atMs,
      iso: new Date(atMs).toISOString(),
      shareAttemptId,
      signal,
    });
  }

  return {
    beginAttempt(nextAttemptId: string) {
      shareAttemptId = nextAttemptId;
      record("SHARE_CALL_STARTED");
    },
    record,
    entries: () => entries.slice(),
    format() {
      if (entries.length === 0) {
        return "(no share signals yet)";
      }
      return entries
        .map((entry) => `${entry.order} ${entry.iso} ${entry.shareAttemptId} ${entry.signal}`)
        .join("\n");
    },
  };
}

export function shareMessageFailedSignal(payload: unknown): string {
  if (payload !== null && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) {
      return `shareMessageFailed:${error}`;
    }
  }
  if (typeof payload === "string" && payload.length > 0) {
    return `shareMessageFailed:${payload}`;
  }
  return "shareMessageFailed:unparsed";
}

export function visibilityChangedSignal(payload: unknown, eventName = "visibilityChanged"): string {
  if (typeof payload === "boolean" || typeof payload === "string" || typeof payload === "number") {
    return `${eventName}:${String(payload)}`;
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as { is_visible?: unknown; isVisible?: unknown; visible?: unknown };
    const value = record.is_visible ?? record.isVisible ?? record.visible;
    if (typeof value === "boolean" || typeof value === "string") {
      return `${eventName}:${String(value)}`;
    }
    try {
      return `${eventName}:${JSON.stringify(payload)}`;
    } catch {
      return `${eventName}:unparsed`;
    }
  }
  return `${eventName}:unparsed`;
}
