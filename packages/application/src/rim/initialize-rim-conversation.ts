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
import { executeProductEvent } from "../execute.ts";
import type { RimAiPort } from "./rim-ai-port.ts";
import {
  conversationPortFrom,
  PRODUCT_SEMANTICS_UNAVAILABLE,
  RIM_PROMPT_UNAVAILABLE,
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

/**
 * In-process creates that have claimed acceptance-unknown and not yet finished.
 * A crash drops this set, so the next recovery treats acceptance-unknown as final.
 */
const inFlightInitialization = new Map<string, Promise<void>>();

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
  return recoverAcceptanceUnknown(tools, loaded, applicable, reentry);
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
  const key = flightKey(tools.context.currentUserId, runtime.initialization.attemptId);
  const existing = inFlightInitialization.get(key);
  if (existing) {
    await existing;
    return reconcileRimInitialization(tools, reentry + 1);
  }
  // Reserve before the claim CAS yields. A revision loser can otherwise observe
  // acceptance-unknown before this map entry exists and dispatch E-64.
  let resolveFlight: () => void = () => undefined;
  const flight = new Promise<void>((resolve) => {
    resolveFlight = resolve;
  });
  inFlightInitialization.set(key, flight);
  let retry = false;
  let result: ApplicationExecutionResult | null = null;
  try {
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
    const saved = await trySave(tools, loaded.revision, claimed);
    if (!saved.ok) {
      retry = true;
    } else {
      note(tools, "initialization-claimed");
      result = await submitClaimedInitialization(tools, claimed);
    }
  } finally {
    resolveFlight();
    if (inFlightInitialization.get(key) === flight) {
      inFlightInitialization.delete(key);
    }
  }
  if (retry) {
    return reconcileRimInitialization(tools, reentry + 1);
  }
  return result;
}

async function submitClaimedInitialization(
  tools: RimInitializationTools,
  claimed: RimProviderRuntime,
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
    return persistStoredInitialization(tools, request, result.conversationId);
  } catch {
    note(tools, "initialization-acceptance-unknown");
    return dispatchUnrecoverable(tools, request);
  }
}

async function persistStoredInitialization(
  tools: RimInitializationTools,
  request: RimConversationInitializationRequest,
  conversationId: ProviderConversationId,
): Promise<ApplicationExecutionResult | null> {
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const current = correlatedAcceptanceUnknown(loaded, request);
  if (!current) {
    note(tools, "stale-initialization-success-discarded");
    return null;
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
  const saved = await trySave(tools, loaded.revision, stored);
  if (!saved.ok) {
    note(tools, "stale-initialization-success-discarded");
    return null;
  }
  note(tools, "initialization-stored");
  return null;
}

async function recoverAcceptanceUnknown(
  tools: RimInitializationTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  reentry: number,
): Promise<ApplicationExecutionResult | null> {
  if (runtime.initialization.submissionState !== "acceptance-unknown") {
    return null;
  }
  const key = flightKey(tools.context.currentUserId, runtime.initialization.attemptId);
  const flight = inFlightInitialization.get(key);
  if (flight) {
    await flight;
    return reconcileRimInitialization(tools, reentry + 1);
  }
  const ready = readyChat(loaded.snapshot);
  if (!ready || !runtimeMatches(runtime, ready)) {
    return null;
  }
  note(tools, "initialization-acceptance-unknown");
  return dispatchUnrecoverable(
    tools,
    initializationRequest(loaded.snapshot, ready, runtime, tools.context.currentUserId),
  );
}

async function dispatchUnrecoverable(
  tools: RimInitializationTools,
  request: RimConversationInitializationRequest,
): Promise<ApplicationExecutionResult | null> {
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  if (!correlatedAcceptanceUnknown(loaded, request)) {
    return null;
  }
  note(tools, "e64-dispatched");
  return executeProductEvent(
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
  return {
    rimChatId: ready.chat.id,
    selectedContactId: ready.chat.selectedContactId,
    contextRequestId: ready.requestId,
    attemptId: runtime.initialization.attemptId,
    clientRequestId: runtime.initialization.clientRequestId,
    rimPrompt: RIM_PROMPT_UNAVAILABLE,
    productSemantics: PRODUCT_SEMANTICS_UNAVAILABLE,
    relationshipContext: ready.data,
    origin: validAskRimOrigin(snapshot, currentUserId),
  };
}

function flightKey(userId: string, attemptId: string): string {
  return `${userId}:${attemptId}`;
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
