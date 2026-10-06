import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import {
  createShareSignalLog,
  formatRawTelegramEvent,
  installRawTelegramIngressObserver,
  shareMessageFailedSignal,
  visibilityChangedSignal,
  type RawTelegramIngressHost,
} from "./telegram-share-signal-log.ts";

const SECRET_INIT = "query_id=AAE&user=%7B%22id%22%3A1%7D&hash=deadbeefcafebabe&auth_date=1";

describe("TEST UI Telegram share signal log", () => {
  it("records ordered signals for one attempt and does not invent a product event", () => {
    let clock = 1_700_000_000_000;
    const log = createShareSignalLog(() => {
      clock += 10;
      return clock;
    });
    log.beginAttempt("attempt-1");
    log.record("callback:true");
    log.record("shareMessageSent");
    log.record(shareMessageFailedSignal({ error: "USER_DECLINED" }));
    const entries = log.entries();
    expect(entries.map((entry) => entry.signal)).toEqual([
      "SHARE_CALL_STARTED",
      "callback:true",
      "shareMessageSent",
      "shareMessageFailed:USER_DECLINED",
    ]);
    expect(entries.map((entry) => entry.order)).toEqual([1, 2, 3, 4]);
    expect(entries.every((entry) => entry.shareAttemptId === "attempt-1")).toBe(true);
    expect(log.format()).toContain("attempt-1 SHARE_CALL_STARTED");
    expect(log.format()).not.toContain("CREATE_BAN");
  });

  it("formats failure reasons and visibility values without collapsing them", () => {
    expect(shareMessageFailedSignal({ error: "MESSAGE_SEND_FAILED" })).toBe(
      "shareMessageFailed:MESSAGE_SEND_FAILED",
    );
    expect(shareMessageFailedSignal("UNKNOWN_ERROR")).toBe("shareMessageFailed:UNKNOWN_ERROR");
    expect(shareMessageFailedSignal(null)).toBe("shareMessageFailed:unparsed");
    expect(visibilityChangedSignal(true)).toBe("visibilityChanged:true");
    expect(visibilityChangedSignal({ is_visible: false })).toBe("visibilityChanged:false");
  });

  it("records raw ingress without dispatching a product event", () => {
    const source = readFileSync(new URL("./telegram-share-signal-log.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@98plus/product-model");
    expect(source).not.toContain("sendEvent");
    expect(source).not.toContain("CREATE_BAN");

    let clock = 1_700_000_000_000;
    const log = createShareSignalLog(() => {
      clock += 10;
      return clock;
    });
    let originalCalls = 0;
    const productDispatches = 0;
    const host: RawTelegramIngressHost = {
      Telegram: {
        WebView: {
          receiveEvent() {
            originalCalls += 1;
          },
        },
      },
    };
    expect(
      installRawTelegramIngressObserver(host, (eventType, eventData) => {
        log.recordRaw(eventType, eventData);
      }),
    ).toBe("installed");
    host.Telegram?.WebView?.receiveEvent?.("prepared_message_sent", { initData: SECRET_INIT });
    expect(originalCalls).toBe(1);
    expect(productDispatches).toBe(0);
    expect(log.entries()).toEqual([]);

    log.beginAttempt("attempt-raw");
    host.Telegram?.WebView?.receiveEvent?.("prepared_message_sent", undefined);
    expect(originalCalls).toBe(2);
    expect(productDispatches).toBe(0);
    expect(log.entries().map((entry) => entry.signal)).toEqual([
      "SHARE_CALL_STARTED",
      "RAW_TELEGRAM_EVENT prepared_message_sent",
    ]);
    expect(log.entries().every((entry) => entry.shareAttemptId === "attempt-raw")).toBe(true);
    expect(log.format()).not.toContain("CREATE_BAN");
    expect(log.format()).not.toContain("E-08");
    expect(log.format()).not.toContain("E-45");
    expect(log.format()).not.toContain("E-65");
  });

  it("records prepared_message_failed with USER_DECLINED and a technical failure", () => {
    const log = createShareSignalLog(() => 1_700_000_000_000);
    log.beginAttempt("attempt-fail");
    log.recordRaw("prepared_message_failed", { error: "USER_DECLINED" });
    log.recordRaw("prepared_message_failed", { error: "MESSAGE_SEND_FAILED" });
    expect(log.entries().map((entry) => entry.signal)).toEqual([
      "SHARE_CALL_STARTED",
      "RAW_TELEGRAM_EVENT prepared_message_failed error=USER_DECLINED",
      "RAW_TELEGRAM_EVENT prepared_message_failed error=MESSAGE_SEND_FAILED",
    ]);
    expect(formatRawTelegramEvent("prepared_message_failed", "USER_DECLINED")).toBe(
      "RAW_TELEGRAM_EVENT prepared_message_failed error=USER_DECLINED",
    );
  });

  it("records unrelated raw event names without dumping payload", () => {
    const log = createShareSignalLog(() => 1_700_000_000_000);
    log.beginAttempt("attempt-other");
    log.recordRaw("viewport_changed", {
      height: 640,
      initData: SECRET_INIT,
      hash: "deadbeefcafebabe",
    });
    log.recordRaw("theme_changed", SECRET_INIT);
    log.recordRaw("not a safe name", { error: "USER_DECLINED", initData: SECRET_INIT });
    const signals = log.entries().map((entry) => entry.signal);
    expect(signals).toEqual([
      "SHARE_CALL_STARTED",
      "RAW_TELEGRAM_EVENT viewport_changed",
      "RAW_TELEGRAM_EVENT theme_changed",
      "RAW_TELEGRAM_EVENT unnamed",
    ]);
    const text = log.format();
    expect(text).not.toContain("query_id");
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("initData");
    expect(text).not.toContain("USER_DECLINED");
    expect(text).not.toContain("640");
  });

  it("keeps the original receiveEvent and does not wrap twice", () => {
    const seen: string[] = [];
    const log = createShareSignalLog(() => 1_700_000_000_000);
    function receiveEvent(this: unknown, eventType: unknown, eventData: unknown) {
      const error =
        eventData !== null && typeof eventData === "object" && "error" in eventData
          ? String((eventData as { error?: unknown }).error)
          : "none";
      const label =
        this !== null && typeof this === "object" && "label" in this
          ? String((this as { label?: unknown }).label)
          : "none";
      seen.push(`${label}:${String(eventType)}:${error}`);
    }
    const host: RawTelegramIngressHost = {
      Telegram: { WebView: { receiveEvent } },
      TelegramGameProxy: { receiveEvent },
      TelegramGameProxy_receiveEvent: receiveEvent,
    };
    const highLevel: string[] = [];
    const original = host.Telegram?.WebView?.receiveEvent;
    host.Telegram!.WebView!.receiveEvent = function (eventType, eventData) {
      original?.call(this, eventType, eventData);
      if (eventType === "prepared_message_failed") {
        highLevel.push(shareMessageFailedSignal(eventData));
      }
    };
    const pageReceive = host.Telegram!.WebView!.receiveEvent!;
    host.TelegramGameProxy!.receiveEvent = pageReceive;
    host.TelegramGameProxy_receiveEvent = pageReceive;

    expect(
      installRawTelegramIngressObserver(host, (eventType, eventData) => {
        log.recordRaw(eventType, eventData);
      }),
    ).toBe("installed");
    expect(
      installRawTelegramIngressObserver(host, (eventType, eventData) => {
        log.recordRaw(eventType, eventData);
      }),
    ).toBe("already");

    log.beginAttempt("attempt-1");
    log.record("callback:false");
    host.Telegram?.WebView?.receiveEvent?.call({ label: "webview" }, "prepared_message_failed", {
      error: "USER_DECLINED",
    });
    host.TelegramGameProxy?.receiveEvent?.call(
      { label: "proxy" },
      "prepared_message_sent",
      undefined,
    );
    expect(seen).toEqual([
      "webview:prepared_message_failed:USER_DECLINED",
      "proxy:prepared_message_sent:none",
    ]);
    expect(highLevel).toEqual(["shareMessageFailed:USER_DECLINED"]);
    expect(log.entries().map((entry) => entry.signal)).toEqual([
      "SHARE_CALL_STARTED",
      "callback:false",
      "RAW_TELEGRAM_EVENT prepared_message_failed error=USER_DECLINED",
      "RAW_TELEGRAM_EVENT prepared_message_sent",
    ]);
    expect(log.format()).toContain("attempt-1 callback:false");
  });

  it("still reports the original receiveEvent when observation throws", () => {
    let originalCalls = 0;
    const host: RawTelegramIngressHost = {
      Telegram: {
        WebView: {
          receiveEvent() {
            originalCalls += 1;
          },
        },
      },
    };
    installRawTelegramIngressObserver(host, () => {
      throw new Error("diagnostic failed");
    });
    host.Telegram?.WebView?.receiveEvent?.("prepared_message_sent", undefined);
    expect(originalCalls).toBe(1);
  });

  it("keeps frozen 30 / 60 / 360", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
  });
});
