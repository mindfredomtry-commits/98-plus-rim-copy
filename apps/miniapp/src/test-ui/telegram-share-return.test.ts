import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  completeForbidShare,
  createShareReturnLatch,
  planForbidShareCompletion,
} from "./telegram-share-return.ts";

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
    expect(source).not.toContain("openai");
  });
});

const PENDING = "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING";

function completionInput(
  overrides: Partial<{
    controlState: string | null;
    shareAttemptId: string | null;
    preparedMessageId: string | null;
    shareMessageAvailable: boolean;
  }> = {},
) {
  return {
    controlState: PENDING,
    shareAttemptId: "attempt-1",
    preparedMessageId: "prep-1",
    shareMessageAvailable: true,
    ...overrides,
  };
}

describe("deterministic template-share completion", () => {
  it("invokes share with the prepared id and then dispatches one E-66 without a callback or visibility change", async () => {
    const order: string[] = [];
    const result = await completeForbidShare({
      ...completionInput(),
      latch: createShareReturnLatch(),
      invokeShareMessage: (preparedMessageId) => {
        order.push(`invoke:${preparedMessageId}`);
      },
      dispatchReturned: async (shareAttemptId) => {
        order.push(`e66:${shareAttemptId}`);
      },
    });
    expect(result).toBe("DISPATCHED");
    expect(order).toEqual(["invoke:prep-1", "e66:attempt-1"]);
  });

  it("callback true, callback false, send, and cancel do not change the E-66 outcome", async () => {
    for (const signal of [
      "callback:true",
      "callback:false",
      "shareMessageSent",
      "shareMessageFailed",
    ]) {
      const order: string[] = [];
      const latch = createShareReturnLatch();
      const result = await completeForbidShare({
        ...completionInput(),
        latch,
        invokeShareMessage: () => {
          order.push("invoke");
          expect(latch.observe(signal).dispatch).toBe(false);
        },
        dispatchReturned: async () => {
          order.push("e66");
        },
      });
      expect(result).toBe("DISPATCHED");
      expect(order).toEqual(["invoke", "e66"]);
      expect(latch.failOpen("attempt-1").dispatch).toBe(false);
    }
  });

  it("dispatches E-66 once when prepare fails or shareMessage is unavailable", async () => {
    const missing: string[] = [];
    const missingNotices: string[] = [];
    expect(
      await completeForbidShare({
        ...completionInput({ preparedMessageId: "" }),
        latch: createShareReturnLatch(),
        invokeShareMessage: () => {
          missing.push("invoke");
        },
        dispatchReturned: async (shareAttemptId) => {
          missing.push(shareAttemptId);
        },
        onNotice: (notice) => {
          missingNotices.push(notice.code);
        },
      }),
    ).toBe("DISPATCHED");
    expect(missing).toEqual(["attempt-1"]);
    expect(missingNotices).toEqual(["TELEGRAM_SHARE_PREPARE_MISSING"]);

    const unavailable: string[] = [];
    expect(
      await completeForbidShare({
        ...completionInput({ preparedMessageId: "prep-1", shareMessageAvailable: false }),
        latch: createShareReturnLatch(),
        invokeShareMessage: () => {
          unavailable.push("invoke");
        },
        dispatchReturned: async () => {
          unavailable.push("e66");
        },
        onNotice: (notice) => {
          unavailable.push(notice.code);
        },
      }),
    ).toBe("DISPATCHED");
    expect(unavailable).toEqual(["e66", "TELEGRAM_SHARE_UNAVAILABLE"]);
  });

  it("still dispatches one E-66 when shareMessage throws", async () => {
    const order: string[] = [];
    const result = await completeForbidShare({
      ...completionInput(),
      latch: createShareReturnLatch(),
      invokeShareMessage: () => {
        order.push("invoke");
        throw new Error("sheet failed");
      },
      dispatchReturned: async () => {
        order.push("e66");
      },
      onNotice: (notice) => {
        order.push(notice.code);
      },
    });
    expect(result).toBe("DISPATCHED");
    expect(order).toEqual(["invoke", "e66", "TELEGRAM_SHARE_OPEN_FAILED"]);
  });

  it("does not dispatch a second E-66 after the attempt completed", async () => {
    const latch = createShareReturnLatch();
    let dispatches = 0;
    let invocations = 0;
    const input = {
      ...completionInput(),
      latch,
      invokeShareMessage: () => {
        invocations += 1;
      },
      dispatchReturned: async () => {
        dispatches += 1;
      },
    };
    expect(await completeForbidShare(input)).toBe("DISPATCHED");
    expect(await completeForbidShare(input)).toBe("ALREADY_COMPLETED");
    expect(dispatches).toBe(1);
    expect(invocations).toBe(1);
    expect(latch.observe("deactivated").dispatch).toBe(false);
    expect(latch.observe("activated").dispatch).toBe(false);
  });

  it("retries E-66 after a failed dispatch without invoking Telegram Share again", async () => {
    const latch = createShareReturnLatch();
    let invocations = 0;
    let attempts = 0;
    const input = {
      ...completionInput(),
      latch,
      invokeShareMessage: () => {
        invocations += 1;
      },
      dispatchReturned: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transport");
        }
      },
    };
    const notices: string[] = [];
    await expect(
      completeForbidShare({ ...input, onNotice: (notice) => notices.push(notice.code) }),
    ).rejects.toThrow("transport");
    expect(
      await completeForbidShare({
        ...input,
        preparedMessageId: null,
        onNotice: (notice) => notices.push(notice.code),
      }),
    ).toBe("DISPATCHED");
    expect(invocations).toBe(1);
    expect(attempts).toBe(2);
    expect(notices).toEqual([]);
    expect(await completeForbidShare(input)).toBe("ALREADY_COMPLETED");
  });

  it("does not dispatch when the sender is not in SHARE_PENDING or the attempt id is missing", async () => {
    const invoke: string[] = [];
    const skipped = await completeForbidShare({
      ...completionInput({ controlState: "CREATE_BAN.SUCCESS" }),
      latch: createShareReturnLatch(),
      invokeShareMessage: () => {
        invoke.push("invoke");
      },
      dispatchReturned: async () => {
        invoke.push("e66");
      },
    });
    expect(skipped).toBe("SKIPPED");
    expect(
      await completeForbidShare({
        ...completionInput({ shareAttemptId: "  " }),
        latch: createShareReturnLatch(),
        invokeShareMessage: () => {
          invoke.push("invoke");
        },
        dispatchReturned: async () => {
          invoke.push("e66");
        },
      }),
    ).toBe("SKIPPED");
    expect(invoke).toEqual([]);
    expect(planForbidShareCompletion(completionInput()).dispatchEvent).toBe(
      "CREATE_BAN.SHARE_RETURNED",
    );
  });

  it("TEST UI attempts shareMessage before E-66 and does not repeat share on session reopen", () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../test-ui.html"),
      "utf8",
    );
    const shareFn = html.slice(
      html.indexOf("async function maybeInvokeTelegramShare"),
      html.indexOf("function isInlineProbeLaunch"),
    );
    const sessionFn = html.slice(
      html.indexOf("async function openSession"),
      html.indexOf('document.getElementById("connect")'),
    );
    expect(shareFn).toContain("completeForbidShare");
    expect(shareFn.indexOf("webApp.shareMessage")).toBeLessThan(
      shareFn.indexOf("CREATE_BAN.SHARE_RETURNED"),
    );
    const callback = shareFn.slice(
      shareFn.indexOf("webApp.shareMessage(preparedMessageId"),
      shareFn.indexOf("});", shareFn.indexOf("webApp.shareMessage(preparedMessageId")),
    );
    expect(callback).toContain("callback:true");
    expect(callback).toContain("callback:false");
    expect(callback).not.toContain("SHARE_RETURNED");
    expect(shareFn).not.toContain("new Promise");
    expect(sessionFn).not.toContain("shareMessage");
    expect(sessionFn).not.toContain("completeForbidShare");
    expect(sessionFn).not.toContain("CREATE_BAN.SHARE_RETURNED");
  });
});
