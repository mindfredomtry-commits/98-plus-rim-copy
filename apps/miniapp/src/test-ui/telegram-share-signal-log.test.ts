import { describe, expect, it } from "vitest";
import {
  createShareSignalLog,
  shareMessageFailedSignal,
  visibilityChangedSignal,
} from "./telegram-share-signal-log.ts";

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
});
