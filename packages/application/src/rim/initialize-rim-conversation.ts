import type { AuthenticatedContext } from "@98plus/identity";
import { PersistenceError, type LoadedSnapshot } from "@98plus/persistence";
import {
  validAskRimOrigin,
  type ContextRequestId,
  type ProductSnapshot,
  type RelationshipContextData,
  type RimChat,
} from "@98plus/product-model";
import type { ApplicationExecutionResult, ProductExecutorDependencies } from "../execute.ts";
import { persistAppliedOnSnapshot } from "../execute.ts";
import {
  RIM_OWNERSHIP_LEASE_SECONDS,
  rimOwnershipRecoveryPermitted,
  startRimOwnershipHeartbeat,
  tokensEqual,
} from "./rim-ownership-lease.ts";
import type { RimAiPort } from "./rim-ai-port.ts";
import {
  conversationPortFrom,
  providerReadySemanticInputs,
  type RimConversationInitializationPort,
  type RimConversationInitializationRequest,
} from "./rim-conversation-port.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type RimProviderAttemptId,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";

export type RimInitializationObservation =
  | "initialization-runtime-created"
  | "initialization-claimed"
  | "initialization-stored"
  | "initialization-acceptance-unknown"
  | "e64-dispatched"
  | "stale-initialization-success-discarded";

const MAX_INIT_REENTRY = 4;

type ReadyChat = Readonly<{
  chat: RimChat;
  requestId: ContextRequestId;
  data: RelationshipContextData;
}>;

export type RimInitializationTools = Readonly<{
  context: AuthenticatedContext;
  clientClaimedUserId?: string;
  deps: ProductExecutorDependencies;
  rimAi: RimAiPort;
  conversation?: RimConversationInitializationPort;
  initializationLog?: RimInitializationObservation[];
}>;

/**
 * Idempotent Conversation initialization for the current ready RimChat.
 * Live E-56 and session recovery both use this helper.
 * It never writes Product state except by dispatching E-64.
 */
export async function reconcileRimInitialization(
  tools: RimInitializationTools,
  reentry = 0,
): Promise<ApplicationExecutionResult | null> {
  if (reentry > MAX_INIT_REENTRY) {
    return null;
  }
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const ready = readyChat(loaded.snapshot);
  if (!ready) {
    return null;
  }
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  if (parsed.status === "INVALID") {
    return null;
  }
  const applicable =
    parsed.status === "PRESENT" ? applicableRimProviderRuntime(parsed, ready.chat.id) : null;
  if (!applicable || !runtimeMatches(applicable, ready)) {
    // A local RimChat keeps its frozen context. A correlation mismatch must not
    // replace that runtime with a new provider Conversation.
    if (applicable?.continuityMode === "local-canonical-history") {
      return null;
    }
    const created = notSubmittedRuntime(ready, tools.deps.allocateId);
    const saved = await trySave(tools, loaded.revision, created);
    if (!saved.ok) {
      return reconcileRimInitialization(tools, reentry + 1);
    }
    note(tools, "initialization-runtime-created");
    return claimAndInitialize(tools, saved.loaded, created, reentry);
  }
  if (applicable.initialization.submissionState === "stored") {
    return null;
  }
  if (applicable.initialization.submissionState === "not-submitted") {
    return claimAndInitialize(tools, loaded, applicable, reentry);
  }
  return recoverAcceptanceUnknown(tools, applicable);
}

function readyChat(snapshot: ProductSnapshot): ReadyChat | null {
  if (snapshot.extended.savedFrozenRimChat !== null) {
    return null;
  }
  if (snapshot.controlState !== "RIM.CHAT" && snapshot.controlState !== "RIM.SELECT_CONTACT") {
    return null;
  }
  const chat = snapshot.extended.rimChat;
  const context = chat?.relationshipContext;
  if (!chat || !context || context.status !== "ready" || !context.data) {
    return null;
  }
  if (context.selectedContactId !== chat.selectedContactId) {
    return null;
  }
  return { chat, requestId: context.requestId, data: context.data };
}

function runtimeMatches(runtime: RimProviderRuntime, ready: ReadyChat): boolean {
  return (
    runtime.rimChatId === ready.chat.id &&
    runtime.selectedContactId === ready.chat.selectedContactId &&
    runtime.contextRequestId === ready.requestId
  );
}

function notSubmittedRuntime(
  ready: ReadyChat,
  allocateId: ProductExecutorDependencies["allocateId"],
): RimProviderRuntime {
  return {
    rimChatId: ready.chat.id,
    selectedContactId: ready.chat.selectedContactId,
    contextRequestId: ready.requestId,
    initialization: {
      submissionState: "not-submitted",
      attemptId: allocateId("rim-initialization") as RimProviderAttemptId,
      clientRequestId: allocateId("rim-client-request"),
    },
    attempt: null,
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

async function claimAndInitialize(
  tools: RimInitializationTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  reentry: number,
): Promise<ApplicationExecutionResult | null> {
  if (runtime.initialization.submissionState !== "not-submitted") {
    return null;
  }
  const claimed: RimProviderRuntime = {
    rimChatId: runtime.rimChatId,
    selectedContactId: runtime.selectedContactId,
    contextRequestId: runtime.contextRequestId,
    initialization: {
      submissionState: "acceptance-unknown",
      attemptId: runtime.initialization.attemptId,
      clientRequestId: runtime.initialization.clientRequestId,
    },
    attempt: runtime.attempt,
    continuityMode: runtime.continuityMode,
    retiredAttemptId: runtime.retiredAttemptId,
    ...(runtime.retryIntent ? { retryIntent: runtime.retryIntent } : {}),
  };
  let acquired: Awaited<
    ReturnType<ProductExecutorDependencies["store"]["acquireRimProviderOwnership"]>
  >;
  try {
    acquired = await tools.deps.store.acquireRimProviderOwnership({
      currentUserId: tools.context.currentUserId,
      expectedRevision: loaded.revision,
      runtime: claimed,
      operationKind: "initialization",
      attemptId: claimed.initialization.attemptId,
      requestId: null,
      leaseSeconds: RIM_OWNERSHIP_LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "REVISION_CONFLICT") {
      return reconcileRimInitialization(tools, reentry + 1);
    }
    throw error;
  }
  if (acquired.status === "ALREADY_PRESENT") {
    return reconcileRimInitialization(tools, reentry + 1);
  }
  note(tools, "initialization-claimed");
  const ownerToken = acquired.ownership.ownerToken;
  const stopHeartbeat = startRimOwnershipHeartbeat(tools.deps.store, {
    currentUserId: tools.context.currentUserId,
    operationKind: "initialization",
    attemptId: claimed.initialization.attemptId,
    ownerToken,
  });
  try {
    return await submitClaimedInitialization(tools, claimed, ownerToken);
  } finally {
    stopHeartbeat();
  }
}

async function submitClaimedInitialization(
  tools: RimInitializationTools,
  claimed: RimProviderRuntime,
  ownerToken: string,
): Promise<ApplicationExecutionResult | null> {
  if (claimed.initialization.submissionState !== "acceptance-unknown") {
    return null;
  }
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const ready = readyChat(loaded.snapshot);
  if (!ready || !runtimeMatches(claimed, ready)) {
    note(tools, "stale-initialization-success-discarded");
    return null;
  }
  const request = initializationRequest(
    loaded.snapshot,
    ready,
    claimed,
    tools.context.currentUserId,
  );
  const port = conversationPortFrom(tools.rimAi, tools.conversation);
  try {
    const result = await port.initialize(request);
    return persistStoredInitialization(tools, request, result.conversationId, ownerToken);
  } catch {
    return recoverAcceptanceUnknown(tools, claimed, ownerToken);
  }
}

async function persistStoredInitialization(
  tools: RimInitializationTools,
  request: RimConversationInitializationRequest,
  conversationId: ProviderConversationId,
  ownerToken: string,
): Promise<ApplicationExecutionResult | null> {
  const saved = await tools.deps.store.withRimProviderOwnershipCoordination(
    {
      currentUserId: tools.context.currentUserId,
      operationKind: "initialization",
      attemptId: request.attemptId,
    },
    async (coordination) => {
      const loaded = await coordination.load();
      const current = correlatedAcceptanceUnknown(loaded, request);
      const ownership = coordination.ownership;
      if (
        !current ||
        !ownership ||
        !tokensEqual(ownership.ownerToken, ownerToken) ||
        ownership.phase === "released"
      ) {
        return false;
      }
      const stored: RimProviderRuntime = {
        rimChatId: current.rimChatId,
        selectedContactId: current.selectedContactId,
        contextRequestId: current.contextRequestId,
        initialization: {
          submissionState: "stored",
          attemptId: request.attemptId,
          conversationId,
          clientRequestId: request.clientRequestId,
        },
        attempt: current.attempt,
        continuityMode: current.continuityMode,
        retiredAttemptId: current.retiredAttemptId,
        ...(current.retryIntent ? { retryIntent: current.retryIntent } : {}),
      };
      await coordination.replaceRuntime(stored);
      await coordination.release(ownerToken, "completed");
      return true;
    },
  );
  note(tools, saved ? "initialization-stored" : "stale-initialization-success-discarded");
  return null;
}

async function recoverAcceptanceUnknown(
  tools: RimInitializationTools,
  runtime: RimProviderRuntime,
  ownerToken?: string,
): Promise<ApplicationExecutionResult | null> {
  if (runtime.initialization.submissionState !== "acceptance-unknown") {
    return null;
  }
  return tools.deps.store.withRimProviderOwnershipCoordination(
    {
      currentUserId: tools.context.currentUserId,
      operationKind: "initialization",
      attemptId: runtime.initialization.attemptId,
    },
    async (coordination) => {
      const loaded = await coordination.load();
      const ready = readyChat(loaded.snapshot);
      if (!ready || !runtimeMatches(runtime, ready)) {
        return null;
      }
      const request = initializationRequest(
        loaded.snapshot,
        ready,
        runtime,
        tools.context.currentUserId,
      );
      if (!correlatedAcceptanceUnknown(loaded, request)) {
        return null;
      }
      if (!rimOwnershipRecoveryPermitted(coordination.ownership, ownerToken)) {
        return null;
      }
      const ended = await persistAppliedOnSnapshot(
        {
          context: tools.context,
          event: {
            name: "RIM.INITIALIZATION_UNRECOVERABLE",
            payload: {
              rimChatId: request.rimChatId,
              selectedContactId: request.selectedContactId,
              contextRequestId: request.contextRequestId,
            },
          },
          ...(tools.clientClaimedUserId === undefined
            ? {}
            : { clientClaimedUserId: tools.clientClaimedUserId }),
        },
        tools.deps,
        loaded,
        (input) => coordination.persistApplied(input),
        async () => {
          if (coordination.ownership && coordination.ownership.phase !== "released") {
            await coordination.invalidate("chat-abandoned");
          }
        },
      );
      if (!ended.persisted) {
        return null;
      }
      note(tools, "initialization-acceptance-unknown");
      note(tools, "e64-dispatched");
      return ended;
    },
  );
}

function correlatedAcceptanceUnknown(
  loaded: LoadedSnapshot,
  request: RimConversationInitializationRequest,
): RimProviderRuntime | null {
  const ready = readyChat(loaded.snapshot);
  if (!ready) {
    return null;
  }
  if (
    ready.chat.id !== request.rimChatId ||
    ready.chat.selectedContactId !== request.selectedContactId ||
    ready.requestId !== request.contextRequestId
  ) {
    return null;
  }
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  const runtime =
    parsed.status === "PRESENT" ? applicableRimProviderRuntime(parsed, ready.chat.id) : null;
  if (!runtime || !runtimeMatches(runtime, ready)) {
    return null;
  }
  if (runtime.initialization.submissionState !== "acceptance-unknown") {
    return null;
  }
  if (runtime.initialization.attemptId !== request.attemptId) {
    return null;
  }
  if (runtime.initialization.clientRequestId !== request.clientRequestId) {
    return null;
  }
  return runtime;
}

function initializationRequest(
  snapshot: ProductSnapshot,
  ready: ReadyChat,
  runtime: RimProviderRuntime,
  currentUserId: RimInitializationTools["context"]["currentUserId"],
): RimConversationInitializationRequest {
  if (runtime.initialization.submissionState === "stored") {
    throw new Error("stored initialization cannot be submitted again");
  }
  const semantics = providerReadySemanticInputs();
  return {
    rimChatId: ready.chat.id,
    selectedContactId: ready.chat.selectedContactId,
    contextRequestId: ready.requestId,
    attemptId: runtime.initialization.attemptId,
    clientRequestId: runtime.initialization.clientRequestId,
    rimPrompt: semantics.rimPrompt,
    productSemantics: semantics.productSemantics,
    relationshipContext: ready.data,
    origin: validAskRimOrigin(snapshot, currentUserId),
  };
}

function note(tools: RimInitializationTools, observation: RimInitializationObservation): void {
  tools.initializationLog?.push(observation);
}

async function trySave(
  tools: RimInitializationTools,
  expectedRevision: number,
  runtime: RimProviderRuntime,
): Promise<{ ok: true; loaded: LoadedSnapshot } | { ok: false; loaded: LoadedSnapshot }> {
  try {
    const loaded = await tools.deps.store.saveRimProviderRuntime(
      tools.context.currentUserId,
      expectedRevision,
      runtime,
    );
    return { ok: true, loaded };
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "REVISION_CONFLICT") {
      const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
      return { ok: false, loaded };
    }
    throw error;
  }
}
