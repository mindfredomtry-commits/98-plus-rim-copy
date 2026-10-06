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
  recordRaw: (eventType: unknown, eventData: unknown) => void;
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
    recordRaw(eventType: unknown, eventData: unknown) {
      if (shareAttemptId === NO_ATTEMPT) {
        return;
      }
      record(formatRawTelegramEvent(eventType, eventData));
    },
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

const SAFE_EVENT_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_ERROR_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const PREPARED_MESSAGE_RESULTS = new Set(["prepared_message_sent", "prepared_message_failed"]);
const INGRESS_MARK = Symbol.for("98plus.rawTelegramIngressObserver");

type ReceiveEvent = (this: unknown, eventType: unknown, eventData: unknown) => void;

type MarkedReceiveEvent = ReceiveEvent & { [INGRESS_MARK]?: true };

export type RawTelegramIngressHost = {
  Telegram?: {
    WebView?: {
      receiveEvent?: ReceiveEvent;
    };
  };
  TelegramGameProxy?: {
    receiveEvent?: ReceiveEvent;
  };
  TelegramGameProxy_receiveEvent?: ReceiveEvent;
};

export type RawTelegramIngressInstall = "installed" | "already" | "unavailable";

function safeEventName(eventType: unknown): string {
  return typeof eventType === "string" && SAFE_EVENT_NAME.test(eventType) ? eventType : "unnamed";
}

function preparedMessageError(eventData: unknown): string | null {
  if (typeof eventData === "string") {
    return SAFE_ERROR_TOKEN.test(eventData) ? eventData : "unparsed";
  }
  if (eventData !== null && typeof eventData === "object" && "error" in eventData) {
    const error = (eventData as { error?: unknown }).error;
    if (typeof error === "string" && SAFE_ERROR_TOKEN.test(error)) {
      return error;
    }
    if (error !== undefined) {
      return "unparsed";
    }
  }
  return null;
}

/**
 * Bounded raw-ingress line. Prepared-message results keep a safe error token.
 * Every other event is recorded by name only.
 */
export function formatRawTelegramEvent(eventType: unknown, eventData: unknown): string {
  const name = safeEventName(eventType);
  if (!PREPARED_MESSAGE_RESULTS.has(name)) {
    return `RAW_TELEGRAM_EVENT ${name}`;
  }
  const error = preparedMessageError(eventData);
  if (name === "prepared_message_sent" && error === null) {
    return `RAW_TELEGRAM_EVENT ${name}`;
  }
  return `RAW_TELEGRAM_EVENT ${name} error=${error ?? "unparsed"}`;
}

function isObserved(fn: ReceiveEvent): boolean {
  return (fn as MarkedReceiveEvent)[INGRESS_MARK] === true;
}

/**
 * Observe native Telegram WebView ingress.
 *
 * Official telegram-web-app.js publishes one function as:
 * - window.Telegram.WebView.receiveEvent
 * - window.TelegramGameProxy.receiveEvent
 * - window.TelegramGameProxy_receiveEvent
 *
 * Native Android calls the WebView property. The wrapper then listens for
 * prepared_message_sent / prepared_message_failed and, only while a share is
 * open, emits shareMessageSent / shareMessageFailed. This wrap records the raw
 * call, then invokes that same function so the wrapper is unchanged.
 * Iframe parent postMessage calls the script's closed-over receiveEvent and
 * does not pass through these properties.
 */
export function installRawTelegramIngressObserver(
  host: RawTelegramIngressHost,
  record: (eventType: unknown, eventData: unknown) => void,
): RawTelegramIngressInstall {
  const webView = host.Telegram?.WebView;
  const primary = webView?.receiveEvent;
  if (!webView || typeof primary !== "function") {
    return "unavailable";
  }
  if (isObserved(primary)) {
    return "already";
  }

  const wrappedByOriginal = new WeakMap<ReceiveEvent, ReceiveEvent>();
  function observe(original: ReceiveEvent): ReceiveEvent {
    if (isObserved(original)) {
      return original;
    }
    const existing = wrappedByOriginal.get(original);
    if (existing !== undefined) {
      return existing;
    }
    const wrapped: MarkedReceiveEvent = function (
      this: unknown,
      eventType: unknown,
      eventData: unknown,
    ) {
      try {
        record(eventType, eventData);
      } catch {
        /* observation must not block the Telegram wrapper */
      }
      return original.call(this, eventType, eventData);
    };
    wrapped[INGRESS_MARK] = true;
    wrappedByOriginal.set(original, wrapped);
    return wrapped;
  }

  const wrappedPrimary = observe(primary);
  webView.receiveEvent = wrappedPrimary;

  const gameProxy = host.TelegramGameProxy;
  if (gameProxy && typeof gameProxy.receiveEvent === "function") {
    gameProxy.receiveEvent = observe(gameProxy.receiveEvent);
  }
  if (typeof host.TelegramGameProxy_receiveEvent === "function") {
    host.TelegramGameProxy_receiveEvent = observe(host.TelegramGameProxy_receiveEvent);
  }
  return "installed";
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
