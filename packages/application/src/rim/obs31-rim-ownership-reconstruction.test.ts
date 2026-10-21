/**
 * OBS-3.1 — D12 real RIM AI ownership/timeout/stale reconstruction.
 * Layer A (this file) drives FakeRimAi + ownership. Layer B receives only
 * serializeCaptureForInvestigator output + opaque correlationId.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CommitOwnedTransitionInput, ProductStore } from "@98plus/persistence";
import { PersistenceTestKit } from "../../../persistence/src/test-kit.ts";
import {
  createDiagnosticContext,
  diagnosticLineLooksSensitive,
  reconstructIncident,
  runWithDiagnosticContextAsync,
  serializeCaptureForInvestigator,
  setDiagnosticSink,
  startDiagnosticCapture,
  type DiagnosticCaptureSession,
  type DiagnosticRecord,
} from "@98plus/diagnostics";
import {
  counterAllocator,
  emptySnapshot,
  type ProductSnapshot,
  type RimChat,
} from "@98plus/product-model";
import {
  AI_REQUEST_ID,
  CHAT_ID,
  CONTACT_A,
  REQUEST_ID,
  USER_ID,
  makeChat,
  pendingAi,
  readyContext,
  withChat,
  withControlState,
} from "../../../product-model/src/kernel.fixtures.ts";
import { authContext } from "../test-harness.ts";
import type { ProductExecutorDependencies } from "../execute.ts";
import { FakeRimAiFailure } from "./fake-rim-ai-adapter.ts";
import { recoverPendingRimAi } from "./recover-pending-rim-ai.ts";
import type { RimAiRequest } from "./rim-ai-port.ts";
import type { RimProviderRetrievalPort } from "./rim-provider-retrieval.ts";
import {
  parseRimProviderRuntime,
  type ProviderConversationId,
  type ProviderResponseId,
  type RimProviderAttempt,
  type RimProviderAttemptId,
  type RimProviderInitialization,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";

const RESPONSE_ID = "resp-known-1" as ProviderResponseId;

const CANARY_USER = "CANARY_RIM_USER_MSG_OBS31_ZZZ";
const CANARY_AI = "CANARY_AI_RESPONSE_OBS31_ZZZ";
const CANARY_PROMPT = "CANARY_OPENAI_PROMPT_OBS31_ZZZ";
const CANARY_ERROR = "CANARY_ERROR_CAUSE_OBS31_ZZZ";

function attempt(value: string): RimProviderAttemptId {
  return value as RimProviderAttemptId;
}

function blind(records: readonly DiagnosticRecord[], correlationId: string) {
  return reconstructIncident(serializeCaptureForInvestigator(records), correlationId);
}

function pendingChat(text = CANARY_USER): RimChat {
  return makeChat({
    selectedContactId: CONTACT_A,
    relationshipContext: readyContext(),
    messages: [{ kind: "USER", text }],
    aiOperation: pendingAi({ userMessage: text, rimChatId: CHAT_ID }),
  });
}

function runtimeFor(
  chat: RimChat,
  submission: RimProviderAttempt["submissionState"],
): RimProviderRuntime {
  const initialization: RimProviderInitialization = {
    submissionState: "stored",
    attemptId: attempt("init-1"),
    conversationId: "conv-stored-1" as ProviderConversationId,
    clientRequestId: null,
  };
  const requestId =
    chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : AI_REQUEST_ID;
  if (submission === "response-id-known") {
    return {
      rimChatId: chat.id,
      selectedContactId: chat.selectedContactId ?? CONTACT_A,
      contextRequestId: chat.relationshipContext?.requestId ?? REQUEST_ID,
      initialization,
      attempt: {
        requestId,
        attemptId: attempt("attempt-a"),
        submissionState: "response-id-known",
        responseId: RESPONSE_ID,
        clientRequestId: "client-1",
      },
      continuityMode: "provider-conversation",
      retiredAttemptId: null,
    };
  }
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId ?? CONTACT_A,
    contextRequestId: chat.relationshipContext?.requestId ?? REQUEST_ID,
    initialization,
    attempt: {
      requestId,
      attemptId: attempt("attempt-a"),
      submissionState: "not-submitted",
      clientRequestId: "client-1",
    },
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

function localRuntime(chat: RimChat, attemptId = "attempt-local"): RimProviderRuntime {
  const requestId =
    chat.aiOperation.status === "PENDING" ? chat.aiOperation.requestId : AI_REQUEST_ID;
  return {
    ...runtimeFor(chat, "not-submitted"),
    continuityMode: "local-canonical-history",
    retiredAttemptId: attempt("attempt-retired"),
    attempt: {
      requestId,
      attemptId: attempt(attemptId),
      submissionState: "not-submitted",
      clientRequestId: null,
    },
  };
}

function chatSnapshot(
  chat: RimChat,
  control: ProductSnapshot["controlState"] = "RIM.CHAT",
): ProductSnapshot {
  return withChat(withControlState(emptySnapshot(), control), chat);
}

async function installPending(chat = pendingChat()) {
  const kit = PersistenceTestKit.inMemory();
  kit.establishIdentity(USER_ID, "tg-user");
  kit.establishIdentity(CONTACT_A, "tg-contact");
  const context = authContext(USER_ID, "tg-user");
  const deps: ProductExecutorDependencies = {
    store: kit.store,
    clock: { nowMs: () => 2_000_000 },
    allocateId: counterAllocator(1),
  };
  const installed = await kit.installFixtureSnapshot(USER_ID, chatSnapshot(chat));
  return { kit, store: kit.store, context, deps, chat, installed };
}

async function saveRuntime(store: ProductStore, runtime: RimProviderRuntime): Promise<void> {
  const loaded = await store.loadProductSnapshot(USER_ID);
  await store.saveRimProviderRuntime(USER_ID, loaded.revision, runtime);
}

async function readRuntime(store: ProductStore) {
  const loaded = await store.loadProductSnapshot(USER_ID);
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  if (parsed.status !== "PRESENT") {
    throw new Error(`expected a provider runtime, got ${parsed.status}`);
  }
  return { loaded, runtime: parsed.runtime };
}

function rimTexts(chat: RimChat | null | undefined): string[] {
  return (chat?.messages ?? []).flatMap((message) =>
    message.kind === "RIM" ? [message.text] : [],
  );
}

function userTexts(chat: RimChat | null | undefined): string[] {
  return (chat?.messages ?? []).flatMap((message) =>
    message.kind === "USER" ? [message.text] : [],
  );
}

function retrieval(
  status: "completed" | "failed",
  output?: unknown,
): RimProviderRetrievalPort {
  return {
    async retrieve(responseId) {
      return {
        responseId,
        providerStatus: status,
        ...(output === undefined ? {} : { output }),
      };
    },
  };
}

function supersedeBeforeOwnedCommit(
  inner: ProductStore,
  replacement: RimProviderRuntime,
): ProductStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "commitOwnedTransition") {
        return async (input: CommitOwnedTransitionInput) => {
          const current = await target.loadProductSnapshot(input.currentUserId);
          await target.saveRimProviderRuntime(input.currentUserId, current.revision, replacement);
          return target.commitOwnedTransition(input);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function timeoutFailure(): FakeRimAiFailure {
  return new FakeRimAiFailure({
    code: "RIM_AI_PROVIDER_TIMEOUT",
    message: CANARY_ERROR,
  } as never);
}

describe("OBS-3.1 D12 real RIM ownership reconstruction", () => {
  let session: DiagnosticCaptureSession | null = null;

  afterEach(() => {
    if (session) {
      session.stop();
      session = null;
    }
    setDiagnosticSink(null);
  });

  it("D12A — real local FakeRimAi timeout → AI_TIMEOUT; no result applied", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, localRuntime(opened.chat));
    const seen: RimAiRequest[] = [];
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);

    const result = await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId }),
      async () =>
        recoverPendingRimAi({
          context: opened.context,
          deps: opened.deps,
          rimAi: {
            async respond(request) {
              seen.push(request);
              throw timeoutFailure();
            },
          },
          retrieval: null,
        }),
    );

    const records = session.stop();
    session = null;

    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    expect(seen[0]?.requestId).toBe(AI_REQUEST_ID);

    const after = await readRuntime(opened.store);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation).toMatchObject({
      status: "PENDING",
      requestId: AI_REQUEST_ID,
    });
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual([]);
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual([CANARY_USER]);

    const timeoutEvents = records.filter(
      (r) => r.correlationId === correlationId && r.eventName === "rim.request.timeout",
    );
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0]?.meta.classification).toBe("AI_TIMEOUT");
    expect(timeoutEvents[0]?.meta.requestId).toBe(AI_REQUEST_ID);
    expect(timeoutEvents[0]?.meta.attemptId).toBe(attempt("attempt-local"));
    expect(timeoutEvents[0]?.meta.errorCode).toBe("RIM_AI_PROVIDER_TIMEOUT");

    const started = records.find(
      (r) => r.correlationId === correlationId && r.eventName === "rim.request.started",
    );
    expect(started?.meta.requestId).toBe(AI_REQUEST_ID);

    const verdict = blind(records, correlationId);
    expect(verdict.classification).toBe("AI_TIMEOUT");
    expect(verdict.firstObservableBoundary).toBe("rim.request");
    expect(verdict.rootCauseEstablished).toBe(true);

    const blob = JSON.stringify(serializeCaptureForInvestigator(records));
    expect(blob.includes(CANARY_USER)).toBe(false);
    expect(blob.includes(CANARY_AI)).toBe(false);
    expect(blob.includes(CANARY_PROMPT)).toBe(false);
    expect(blob.includes(CANARY_ERROR)).toBe(false);
    expect(diagnosticLineLooksSensitive(blob)).toBe(false);
  });

  it("D12B — real superseded retrieval → STALE_AI_RESULT; no stale apply", async () => {
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const replacement = localRuntime(opened.chat, "attempt-b");
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);

    const raced = await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId }),
      async () =>
        recoverPendingRimAi({
          context: opened.context,
          deps: {
            ...opened.deps,
            store: supersedeBeforeOwnedCommit(opened.store, replacement),
          },
          rimAi: {
            async respond() {
              return { kind: "MESSAGE", text: CANARY_AI };
            },
          },
          retrieval: retrieval("completed", { kind: "MESSAGE", text: CANARY_AI }),
        }),
    );

    const records = session.stop();
    session = null;

    expect(raced).toBeNull();
    const after = await readRuntime(opened.store);
    expect(after.runtime).toEqual(replacement);
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual([]);
    expect(userTexts(after.loaded.snapshot.extended.rimChat)).toEqual([CANARY_USER]);

    const staleEvents = records.filter(
      (r) => r.correlationId === correlationId && r.eventName === "rim.request.stale",
    );
    expect(staleEvents.length).toBeGreaterThanOrEqual(1);
    expect(staleEvents[0]?.meta.classification).toBe("STALE_AI_RESULT");
    expect(staleEvents[0]?.meta.requestId).toBe(AI_REQUEST_ID);
    expect(staleEvents[0]?.meta.attemptId).toBe(attempt("attempt-a"));

    const verdict = blind(records, correlationId);
    expect(verdict.classification).toBe("STALE_AI_RESULT");
    expect(verdict.firstObservableBoundary).toBe("rim.request");

    const blob = JSON.stringify(serializeCaptureForInvestigator(records));
    expect(blob.includes(CANARY_AI)).toBe(false);
    expect(blob.includes(CANARY_USER)).toBe(false);
  });

  it("D12C — concurrent double-claim consolidates to one FakeRimAi; A superseded then B applied once", async () => {
    // Architectural invariant: one logical PENDING request; overlapping recovers
    // share ownership fencing — only one respond() wins.
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "not-submitted"));
    const seen: RimAiRequest[] = [];
    const tools = {
      context: opened.context,
      deps: opened.deps,
      rimAi: {
        async respond(request: RimAiRequest) {
          seen.push(request);
          return { kind: "MESSAGE" as const, text: "only-once" };
        },
      },
      retrieval: null,
    };
    const [first, second] = await Promise.all([
      recoverPendingRimAi(tools),
      recoverPendingRimAi(tools),
    ]);
    expect(seen).toHaveLength(1);
    const completions = [first, second].filter(
      (result) => result?.event.name === "RIM.AI_RESULT_RECEIVED",
    );
    expect(completions).toHaveLength(1);
    expect(
      (await opened.store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation
        .status,
    ).toBe("IDLE");

    // Nearest legitimate supersession path: attempt A retrieval stale, then B completes.
    const supersede = await installPending();
    await saveRuntime(supersede.store, runtimeFor(supersede.chat, "response-id-known"));
    const attemptB = localRuntime(supersede.chat, "attempt-b");
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);

    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId }),
      async () => {
        const stale = await recoverPendingRimAi({
          context: supersede.context,
          deps: {
            ...supersede.deps,
            store: supersedeBeforeOwnedCommit(supersede.store, attemptB),
          },
          rimAi: {
            async respond() {
              return { kind: "MESSAGE", text: CANARY_AI };
            },
          },
          retrieval: retrieval("completed", { kind: "MESSAGE", text: CANARY_AI }),
        });
        expect(stale).toBeNull();

        const applied = await recoverPendingRimAi({
          context: supersede.context,
          deps: supersede.deps,
          rimAi: {
            async respond(request) {
              expect(request.continuityMode).toBe("local-canonical-history");
              return { kind: "MESSAGE", text: "attempt-b-ok" };
            },
          },
          retrieval: null,
        });
        expect(applied?.event.name).toBe("RIM.AI_RESULT_RECEIVED");
        expect(applied?.traces.some((t) => t.eventId === "E-58")).toBe(true);
      },
    );

    const records = session.stop();
    session = null;
    const after = await readRuntime(supersede.store);
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-b"));
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual(["attempt-b-ok"]);
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).not.toContain(CANARY_AI);

    expect(records.some((r) => r.eventName === "rim.request.stale")).toBe(true);
    expect(records.some((r) => r.eventName === "rim.request.completed")).toBe(true);
    const staleAttempt = records.find((r) => r.eventName === "rim.request.stale")?.meta.attemptId;
    const completedAttempt = records.find((r) => r.eventName === "rim.request.completed")?.meta
      .attemptId;
    expect(staleAttempt).toBe(attempt("attempt-a"));
    expect(completedAttempt).toBe(attempt("attempt-b"));
    expect(staleAttempt).not.toBe(completedAttempt);

    const verdict = blind(records, correlationId);
    // First failure in stream is stale; completed follows under same correlation.
    expect(verdict.classification).toBe("STALE_AI_RESULT");
    expect(verdict.evidence).toContain("rim.request.completed");
  });

  it("D12D — recovery re-entry: correlationId not durable; requestId/attemptId linkage survives", async () => {
    // Path 1: timeout leaves local attempt acceptance-unknown (stuck PENDING).
    const timedOut = await installPending();
    await saveRuntime(timedOut.store, localRuntime(timedOut.chat));
    const timeoutCorrelation = randomUUID();
    session = startDiagnosticCapture(timeoutCorrelation);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId: timeoutCorrelation }),
      async () =>
        recoverPendingRimAi({
          context: timedOut.context,
          deps: timedOut.deps,
          rimAi: {
            async respond() {
              throw timeoutFailure();
            },
          },
          retrieval: null,
        }),
    );
    const timeoutRecords = session.stop();
    session = null;
    const timeoutEvent = timeoutRecords.find(
      (r) => r.correlationId === timeoutCorrelation && r.eventName === "rim.request.timeout",
    );
    expect(timeoutEvent?.meta.requestId).toBe(AI_REQUEST_ID);
    expect(timeoutEvent?.meta.attemptId).toBe(attempt("attempt-local"));
    expect(blind(timeoutRecords, timeoutCorrelation).classification).toBe("AI_TIMEOUT");

    const afterTimeout = await readRuntime(timedOut.store);
    expect(afterTimeout.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(afterTimeout.runtime.attempt?.submissionState).toBe("acceptance-unknown");

    // Re-entry after local timeout: new correlationId; started carries requestId.
    // Same acceptance-unknown local attempt is not re-submitted (frozen ownership).
    const stuckCorrelation = randomUUID();
    session = startDiagnosticCapture(stuckCorrelation);
    const stuckSeen: RimAiRequest[] = [];
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId: stuckCorrelation }),
      async () =>
        recoverPendingRimAi({
          context: timedOut.context,
          deps: timedOut.deps,
          rimAi: {
            async respond(request) {
              stuckSeen.push(request);
              throw timeoutFailure();
            },
          },
          retrieval: null,
        }),
    );
    const stuckRecords = session.stop();
    session = null;
    expect(stuckSeen).toHaveLength(0);
    const stuckStarted = stuckRecords.find(
      (r) => r.correlationId === stuckCorrelation && r.eventName === "rim.request.started",
    );
    expect(stuckStarted?.meta.requestId).toBe(AI_REQUEST_ID);
    expect(stuckRecords.some((r) => r.eventName === "rim.request.timeout")).toBe(false);
    expect(stuckCorrelation).not.toBe(timeoutCorrelation);

    // Path 2: durable response-id-known survives restart; retrieval completes under new correlation.
    const durable = await installPending();
    await saveRuntime(durable.store, runtimeFor(durable.chat, "response-id-known"));
    const firstCorrelation = randomUUID();
    session = startDiagnosticCapture(firstCorrelation);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId: firstCorrelation }),
      async () =>
        recoverPendingRimAi({
          context: durable.context,
          deps: durable.deps,
          rimAi: {
            async respond() {
              throw new Error("respond must not run for response-id-known recovery");
            },
          },
          retrieval: {
            async retrieve() {
              return { responseId: RESPONSE_ID, providerStatus: "in_progress" };
            },
          },
        }),
    );
    const firstRecords = session.stop();
    session = null;
    expect(
      firstRecords.find((r) => r.eventName === "rim.request.started")?.meta.requestId,
    ).toBe(AI_REQUEST_ID);
    expect((await readRuntime(durable.store)).runtime.attempt?.attemptId).toBe(
      attempt("attempt-a"),
    );

    const secondCorrelation = randomUUID();
    session = startDiagnosticCapture(secondCorrelation);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId: secondCorrelation }),
      async () =>
        recoverPendingRimAi({
          context: durable.context,
          deps: durable.deps,
          rimAi: {
            async respond() {
              throw new Error("respond must not run for retrieval completion");
            },
          },
          retrieval: retrieval("completed", { kind: "MESSAGE", text: "recovered-ok" }),
        }),
    );
    const secondRecords = session.stop();
    session = null;
    const completed = secondRecords.find(
      (r) => r.correlationId === secondCorrelation && r.eventName === "rim.request.completed",
    );
    expect(completed?.meta.requestId).toBe(AI_REQUEST_ID);
    expect(completed?.meta.attemptId).toBe(attempt("attempt-a"));
    expect(secondCorrelation).not.toBe(firstCorrelation);
    expect(blind(secondRecords, secondCorrelation).classification).toBe("OK");
    expect(
      (await durable.store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat?.aiOperation
        .status,
    ).toBe("IDLE");
    expect(
      rimTexts((await durable.store.loadProductSnapshot(USER_ID)).snapshot.extended.rimChat),
    ).toEqual(["recovered-ok"]);
  });

  it("privacy — canaries in user message / AI body / failure message never enter diagnostics", async () => {
    const opened = await installPending(pendingChat(CANARY_USER));
    await saveRuntime(opened.store, localRuntime(opened.chat));
    const correlationId = randomUUID();
    session = startDiagnosticCapture(correlationId);
    await runWithDiagnosticContextAsync(
      createDiagnosticContext({ source: "rim", correlationId }),
      async () =>
        recoverPendingRimAi({
          context: opened.context,
          deps: opened.deps,
          rimAi: {
            async respond() {
              throw new FakeRimAiFailure({
                code: "RIM_AI_PROVIDER_TIMEOUT",
                message: `${CANARY_ERROR} ${CANARY_PROMPT} ${CANARY_AI}`,
              } as never);
            },
          },
          retrieval: null,
        }),
    );
    const blob = JSON.stringify(serializeCaptureForInvestigator(session.stop()));
    session = null;
    for (const canary of [CANARY_USER, CANARY_AI, CANARY_PROMPT, CANARY_ERROR]) {
      expect(blob.includes(canary)).toBe(false);
    }
  });

  it("failure isolation — throwing diagnostic sink does not change ownership or apply stale result", async () => {
    setDiagnosticSink(() => {
      throw new Error("sink exploded");
    });
    const opened = await installPending();
    await saveRuntime(opened.store, runtimeFor(opened.chat, "response-id-known"));
    const replacement = localRuntime(opened.chat, "attempt-b");
    const raced = await recoverPendingRimAi({
      context: opened.context,
      deps: {
        ...opened.deps,
        store: supersedeBeforeOwnedCommit(opened.store, replacement),
      },
      rimAi: {
        async respond() {
          return { kind: "MESSAGE", text: CANARY_AI };
        },
      },
      retrieval: retrieval("completed", { kind: "MESSAGE", text: CANARY_AI }),
    });
    expect(raced).toBeNull();
    const after = await readRuntime(opened.store);
    expect(after.runtime.attempt?.attemptId).toBe(attempt("attempt-b"));
    expect(after.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
    expect(rimTexts(after.loaded.snapshot.extended.rimChat)).toEqual([]);
    setDiagnosticSink(null);
  });
});
