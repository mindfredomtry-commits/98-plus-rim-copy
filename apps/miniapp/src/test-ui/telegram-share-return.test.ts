import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createShareReturnLatch } from "./telegram-share-return.ts";

const SEND_RETURN = [
  "deactivated",
  "document.visibilitychange:hidden",
  "window.blur",
  "activated",
  "document.visibilitychange:visible",
] as const;

const NOISE = [
  "window.focus",
  "window.blur",
  "viewport_changed",
  "visibility_changed",
  "callback:true",
  "callback:false",
  "shareMessageSent",
  "shareMessageFailed",
  "prepared_message_sent",
  "prepared_message_failed",
] as const;

function returnedOnce(signals: readonly string[], attemptId = "attempt-1") {
  const latch = createShareReturnLatch();
  latch.arm(attemptId);
  const dispatched = signals.flatMap((signal) => {
    const decision = latch.observe(signal);
    return decision.dispatch ? [decision.shareAttemptId] : [];
  });
  return dispatched;
}

describe("native Telegram Share return latch", () => {
  it("dispatches one E-66 payload id on entered then returned", () => {
    expect(returnedOnce(SEND_RETURN)).toEqual(["attempt-1"]);
  });

  it("SEND return and CANCEL / Android Back return dispatch the same single completion", () => {
    expect(returnedOnce(SEND_RETURN, "send")).toEqual(["send"]);
    expect(returnedOnce(SEND_RETURN, "cancel")).toEqual(["cancel"]);
  });

  it("ignores activated, visible, focus, and delivery noise before Entered", () => {
    const latch = createShareReturnLatch();
    latch.arm("attempt-1");
    for (const signal of ["activated", "document.visibilitychange:visible", ...NOISE]) {
      expect(latch.observe(signal).dispatch).toBe(false);
    }
    expect(latch.observe("deactivated").dispatch).toBe(false);
    expect(latch.observe("activated").dispatch).toBe(true);
  });

  it("latches the attempt so later activated, visible, and noise do not dispatch again", () => {
    const latch = createShareReturnLatch();
    latch.arm("attempt-1");
    expect(latch.observe("document.visibilitychange:hidden").dispatch).toBe(false);
    expect(latch.observe("document.visibilitychange:visible").dispatch).toBe(true);
    for (const signal of ["activated", "document.visibilitychange:visible", ...NOISE]) {
      expect(latch.observe(signal).dispatch).toBe(false);
    }
  });

  it("does not dispatch for lifecycle activity that is not the armed attempt", () => {
    const latch = createShareReturnLatch();
    expect(latch.observe("deactivated").dispatch).toBe(false);
    expect(latch.observe("activated").dispatch).toBe(false);
  });

  it("failOpen dispatches once and a later return does not dispatch again", () => {
    const latch = createShareReturnLatch();
    expect(latch.failOpen("attempt-1")).toEqual({
      shareAttemptId: "attempt-1",
      dispatch: true,
    });
    expect(latch.failOpen("attempt-1").dispatch).toBe(false);
    latch.arm("attempt-1");
    expect(latch.observe("deactivated").dispatch).toBe(false);
    expect(latch.observe("activated").dispatch).toBe(false);
  });

  it("stays a client latch and does not import Product events", () => {
    const source = readFileSync(new URL("./telegram-share-return.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@98plus/product-model");
    expect(source).not.toContain("sendEvent");
    expect(source).not.toContain("prepared_message_sent");
  });
});
