/**
 * OBS-3 — HTTP / Telegram / Product / privacy / concurrency (Layer A+B).
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCorrelationId,
  createDiagnosticContext,
  diagnosticLineLooksSensitive,
  emitDiagnostic,
  reconstructFromCapture,
  runWithDiagnosticContextAsync,
  serializeCaptureForInvestigator,
  setDiagnosticSink,
  startDiagnosticCapture,
  type DiagnosticRecord,
  type ReconstructionVerdict,
} from "@98plus/diagnostics";
import {
  executeProductEvent,
  randomIdAllocator,
  systemClock,
} from "@98plus/application";
import { asTelegramUserId } from "@98plus/identity";
import { PersistenceTestKit } from "../../../packages/persistence/src/test-kit.ts";
import {
  emptySnapshot,
  type UserId,
} from "@98plus/product-model";
import { branded, withControlState } from "../../../packages/product-model/src/kernel.fixtures.ts";
import { jsonWithDiagnostics } from "./http-diagnostics.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  createCreateBanContactRuntime,
} from "./runtime.ts";
import {
  processTelegramBanUpdate,
} from "./telegram-ban-callback.ts";
import { resetTelegramBanMessageProcessLocksForTests } from "./telegram-ban-message-store.ts";
import { buildTelegramBanOverboardCallbackData } from "./telegram-share.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const DEV_SECRET = "test-secret";

function auth(user: UserId) {
  return {
    currentUserId: user,
    currentTelegramUser: { telegramUserId: asTelegramUserId(`tg-${user}`) },
    authenticationMethod: "development" as const,
  };
}

function blind(records: readonly DiagnosticRecord[], correlationId: string): ReconstructionVerdict {
  return reconstructFromCapture(serializeCaptureForInvestigator(records), correlationId);
}

function authHeaders(telegramUserId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-98-auth-method": "development",
    "x-98-dev-secret": DEV_SECRET,
    "x-98-dev-telegram-user-id": telegramUserId,
  };
}

describe("OBS-3 HTTP/Product/Telegram failure reconstruction", () => {
  let session: ReturnType<typeof startDiagnosticCapture> | null = null;

  beforeEach(() => {
    session = null;
  });
  afterEach(() => {
    session?.stop();
    session = null;
    setDiagnosticSink(null);
  });

  it("D1 Product guard rejection — NOT_APPLIED", async () => {
    const kit = PersistenceTestKit.inMemory();
    const user = branded<UserId>(`u-${randomUUID()}`);
    kit.establishIdentity(user, `tg-${randomUUID()}`);
    await kit.installFixtureSnapshot(user, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "http", correlationId, actorId: user }),
      async () => {
        const result = await executeProductEvent(
          {
            context: auth(user),
            event: { name: "NOTIFICATIONS.PRESS_OVERBOARD", payload: {} },
          },
          {
            store: kit.store,
            clock: systemClock,
            allocateId: randomIdAllocator(),
          },
        );
        expect(result.status).toBe("NOT_APPLIED");
      },
    );
    const all = session.stop();
    session = null;
    const verdict = blind(all, correlationId);
    expect(verdict.classification).toBe("PRODUCT_GUARD_REJECTED");
    expect(verdict.firstObservableBoundary).toBe("product.engine");
    expect(verdict.evidence).toContain("product.event.rejected");
    expect(verdict.evidence).not.toContain("persistence.transaction.committed");
  });

  it("D9 realistic HTTP response failure after writeHead (ServerResponse error)", async () => {
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "http", correlationId }),
      async () => {
        emitDiagnostic({
          eventName: "persistence.transaction.committed",
          source: "persistence",
          meta: { storeKind: "memory", phase: "committed" },
        });
        const res = new EventEmitter() as ServerResponse;
        (res as unknown as { writeHead: () => ServerResponse }).writeHead = () => res;
        (res as unknown as { end: (p?: unknown, cb?: () => void) => ServerResponse }).end = () => {
          queueMicrotask(() => res.emit("error", new Error("socket hang up")));
          return res;
        };
        jsonWithDiagnostics(res, 200, { diagnostics: { ok: true } }, {
          httpMethod: "POST",
          httpPath: "/api/events",
          startedAtMs: Date.now(),
        });
        await new Promise((r) => setTimeout(r, 30));
      },
    );
    const all = session.stop();
    session = null;
    const verdict = blind(all, correlationId);
    expect(verdict.transactionOutcome).toBe("committed");
    expect(verdict.firstObservableBoundary).toBe("http.request");
    expect(verdict.evidence).toContain("request.failed");
    expect(verdict.rootCauseEstablished).toBe(false);
  });

  it("D10A Telegram duplicate callback — real processTelegramBanUpdate path", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "webhook-secret-test";
    process.env.TELEGRAM_BOT_TOKEN = "bot-token-test";
    process.env.TELEGRAM_BOT_USERNAME = "ninety_eight_plus_mvp_bot";
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("api.telegram.org/")) {
        return realFetch(input, init);
      }
      return Response.json({ ok: true, result: true });
    });
    const app = await listenCreateBanContactServer({
      runtime: createCreateBanContactRuntime({ telegramSharePrepare: "mock" }),
      seedTelegramUserIds: [USER_A_TG, USER_B_TG],
    });
    try {
      const sessionPost = async (tg: string, body: Record<string, unknown> = { openIfNeeded: true }) => {
        const response = await fetch(`${app.url}/api/session`, {
          method: "POST",
          headers: authHeaders(tg),
          body: JSON.stringify(body),
        });
        return (await response.json()) as { diagnostics: TestUiDiagnostics };
      };
      const dispatch = async (tg: string, name: string, payload: Record<string, unknown> = {}) => {
        const response = await fetch(`${app.url}/api/events`, {
          method: "POST",
          headers: authHeaders(tg),
          body: JSON.stringify({ name, payload }),
        });
        return (await response.json()) as { diagnostics: TestUiDiagnostics };
      };
      await sessionPost(USER_A_TG);
      await dispatch(USER_A_TG, "CREATE_BAN.PRESS_START");
      await dispatch(USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE");
      await dispatch(USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "obs3 ban" });
      await dispatch(USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
      await dispatch(USER_A_TG, "CREATE_BAN.PRESS_NEXT");
      const pending = await dispatch(USER_A_TG, "CREATE_BAN.PRESS_FORBID");
      const share = (pending.diagnostics.shareOperations as Array<{ token: string }>)[0]!;
      const update = {
        update_id: 701,
        callback_query: {
          id: `cq-${randomUUID()}`,
          from: { id: Number(USER_B_TG) },
          data: buildTelegramBanOverboardCallbackData(share.token),
          inline_message_id: "inline-obs3",
        },
      };
      const first = await processTelegramBanUpdate(app.runtime, update);
      expect(first.code).toBe("OVERBOARD_APPLIED");

      const correlationId = randomUUID();
      session = startDiagnosticCapture(correlationId);
      await runWithDiagnosticContextAsync(
        createDiagnosticContext({
          source: "telegram",
          correlationId,
          telegramUpdateId: update.update_id,
          telegramCallbackQueryId: update.callback_query.id,
        }),
        async () => {
          const duplicate = await processTelegramBanUpdate(app.runtime, update);
          expect(duplicate.code).toBe("DUPLICATE_CALLBACK");
        },
      );
      const all = session.stop();
      session = null;
      const verdict = blind(all, correlationId);
      expect(verdict.firstObservableBoundary).toBe("telegram.callback");
      expect(verdict.evidence).toContain("telegram.callback.duplicate");
      expect(verdict.evidence).not.toContain("telegram.callback.applied");
    } finally {
      resetTelegramBanMessageProcessLocksForTests();
      await app.close();
      vi.unstubAllGlobals();
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_USERNAME;
    }
  }, 60_000);

  it("D10B no callback in observation window", async () => {
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "http", correlationId }),
      async () => {
        emitDiagnostic({
          eventName: "request.received",
          source: "http",
          meta: { httpPath: "/api/session", httpMethod: "POST" },
        });
        emitDiagnostic({
          eventName: "request.completed",
          source: "http",
          meta: { httpPath: "/api/session", httpStatus: 200, responseOutcome: "completed" },
        });
      },
    );
    const all = session.stop();
    session = null;
    const verdict = blind(all, correlationId);
    expect(verdict.firstObservableBoundary).toBe("telegram.callback");
    expect(verdict.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.limitations.some((l) => l.includes("does not prove"))).toBe(true);
  });

  /**
   * D12 — event shapes match recover-pending-rim-ai dispatchIfCurrent emitters.
   * Injection uses the production emit sites' payload contract (not OpenAI).
   * Full FakeRimAi ownership orchestration remains covered by RIM suite filters.
   */
  it("D12A timeout vs D12B stale distinguishable", async () => {
    const timeoutId = randomUUID();
    session = startDiagnosticCapture(timeoutId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId: timeoutId }),
      async () => {
        emitDiagnostic({
          eventName: "rim.request.started",
          source: "rim",
          meta: { requestId: "req-a", attemptId: "att-1" },
        });
        emitDiagnostic({
          eventName: "rim.request.timeout",
          source: "rim",
          meta: {
            classification: "AI_TIMEOUT",
            requestId: "req-a",
            attemptId: "att-1",
          },
        });
      },
    );
    const timeoutVerdict = blind(session.stop(), timeoutId);
    session = null;
    expect(timeoutVerdict.classification).toBe("AI_TIMEOUT");

    const staleId = randomUUID();
    session = startDiagnosticCapture(staleId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId: staleId }),
      async () => {
        emitDiagnostic({
          eventName: "rim.request.stale",
          source: "rim",
          meta: {
            classification: "STALE_AI_RESULT",
            requestId: "req-b",
            attemptId: "att-old",
          },
        });
      },
    );
    const staleVerdict = blind(session.stop(), staleId);
    session = null;
    expect(staleVerdict.classification).toBe("STALE_AI_RESULT");
    expect(timeoutVerdict.classification).not.toBe(staleVerdict.classification);
  });

  it("O-privacy canaries never appear in captured diagnostics", async () => {
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);
    const canaries = {
      banText: "CANARY_BAN_TEXT_SECRET_ZZZ",
      rimMessage: "CANARY_RIM_USER_MSG_ZZZ",
      aiResponse: "CANARY_AI_RESPONSE_ZZZ",
      initData: "user=1&initData=CANARY_INITDATA_ZZZ",
      auth: "Authorization bearer CANARY_TOKEN_ZZZ",
      prompt: "openai prompt CANARY_OPENAI_PROMPT_ZZZ",
    };
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "product", correlationId }),
      async () => {
        emitDiagnostic({
          eventName: "product.event.failed",
          source: "product",
          meta: {
            // Sensitive strings only via forbidden substrings or unknown keys.
            errorMessage: canaries.initData,
            eventId: "E-20",
            banText: canaries.banText,
            rimMessage: canaries.rimMessage,
            aiResponse: canaries.aiResponse,
            prompt: canaries.prompt,
            authorization: canaries.auth,
          } as never,
        });
      },
    );
    const all = session.stop();
    session = null;
    const blob = JSON.stringify(all);
    for (const value of Object.values(canaries)) {
      expect(blob.includes(value)).toBe(false);
    }
    expect(diagnosticLineLooksSensitive(blob)).toBe(false);
  });

  it("logging sink failure does not change Product outcome", async () => {
    setDiagnosticSink(() => {
      throw new Error("sink exploded");
    });
    const kit = PersistenceTestKit.inMemory();
    const user = branded<UserId>(`u-${randomUUID()}`);
    kit.establishIdentity(user, `tg-${randomUUID()}`);
    await kit.installFixtureSnapshot(user, withControlState(emptySnapshot(), "RIM.LOBBY"));
    const before = await kit.store.loadProductSnapshot(user);
    const result = await executeProductEvent(
      {
        context: auth(user),
        event: { name: "NOTIFICATIONS.PRESS_OVERBOARD", payload: {} },
      },
      { store: kit.store, clock: systemClock, allocateId: randomIdAllocator() },
    );
    expect(result.status).toBe("NOT_APPLIED");
    const after = await kit.store.loadProductSnapshot(user);
    expect(after.revision).toBe(before.revision);
    setDiagnosticSink(null);
  });

  it("concurrent actions do not cross-contaminate correlation context", async () => {
    const a = randomUUID();
    const b = randomUUID();
    session = startDiagnosticCapture(a);
    await Promise.all([
      runWithDiagnosticContextAsync(createDiagnosticContext({ source: "http", correlationId: a }), async () => {
        emitDiagnostic({
          eventName: "product.event.applied",
          source: "product",
          meta: { actionId: createCorrelationId(), eventId: "E-15" },
        });
        await new Promise((r) => setTimeout(r, 5));
        emitDiagnostic({
          eventName: "product.event.applied",
          source: "product",
          meta: { actionId: createCorrelationId(), eventId: "E-20" },
        });
      }),
      runWithDiagnosticContextAsync(createDiagnosticContext({ source: "http", correlationId: b }), async () => {
        emitDiagnostic({
          eventName: "rim.request.timeout",
          source: "rim",
          meta: { classification: "AI_TIMEOUT", requestId: "r-b", attemptId: "a-b" },
        });
      }),
    ]);
    const all = session.stop();
    session = null;
    const va = blind(all, a);
    const vb = blind(all, b);
    expect(va.evidence.every((e) => e.startsWith("product.") || e.startsWith("request."))).toBe(
      true,
    );
    expect(va.evidence).not.toContain("rim.request.timeout");
    expect(vb.classification).toBe("AI_TIMEOUT");
    expect(vb.evidence).not.toContain("product.event.applied");
  });
});
