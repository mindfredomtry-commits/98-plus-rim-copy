import type { AuthenticatedContext } from "@98plus/identity";
import { PersistenceError, type LoadedSnapshot } from "@98plus/persistence";
import {
  validAskRimOrigin,
  type AiRequestId,
  type AskRimOrigin,
  type Failure,
  type ProductSnapshot,
  type RelationshipContextData,
  type RimChat,
  type RimRequestSnapshot,
} from "@98plus/product-model";
import type { ApplicationExecutionResult, ProductExecutorDependencies } from "../execute.ts";
import { executeProductEvent } from "../execute.ts";
import type { ProductEventInput } from "../event.ts";
import { FakeRimAiFailure } from "./fake-rim-ai-adapter.ts";
import {
  reconcileRimInitialization,
  type RimInitializationObservation,
} from "./initialize-rim-conversation.ts";
import type { RimAiPort, RimAiRequest } from "./rim-ai-port.ts";
import type { RimConversationInitializationPort } from "./rim-conversation-port.ts";
import type { RimProviderRetrievalPort } from "./rim-provider-retrieval.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type ProviderResponseId,
  type RetrievedProviderStatus,
  type RimProviderAttempt,
  type RimProviderAttemptId,
  type RimProviderRuntime,
} from "./rim-provider-runtime.ts";
import { RIM_AI_OUTPUT_INVALID, validateRimAiOutput } from "./validate-rim-ai-output.ts";

const MAX_CLAIM_REENTRY = 1;

const EMPTY_CONTEXT: RelationshipContextData = {
  aggregates: {
    userToContact: {
      bansSentCount: 0,
      statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
    },
    contactToUser: {
      bansSentCount: 0,
      statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
    },
  },
  recentBans: [],
};

type PendingChat = Readonly<{
  chat: RimChat;
  snapshot: RimRequestSnapshot;
}>;

type OriginSource =
  { readonly kind: "effect"; readonly value: AskRimOrigin | null } | { readonly kind: "current" };

type ReconcileTools = Readonly<{
  context: AuthenticatedContext;
  clientClaimedUserId?: string;
  deps: ProductExecutorDependencies;
  rimAi: RimAiPort;
  conversation?: RimConversationInitializationPort;
  initializationLog?: RimInitializationObservation[];
  retrieval: RimProviderRetrievalPort | null;
  mode: "live" | "recover";
  origin: OriginSource;
  inFlightRequestIds: readonly string[];
}>;

export type PendingRimAiTools = Readonly<{
  context: AuthenticatedContext;
  clientClaimedUserId?: string;
  deps: ProductExecutorDependencies;
  rimAi: RimAiPort;
  conversation?: RimConversationInitializationPort;
  initializationLog?: RimInitializationObservation[];
  retrieval: RimProviderRetrievalPort | null;
}>;

/**
 * Completes one live REQUEST_RIM_AI effect.
 * Conversation initialization is reconciled first. respond runs only after it is stored.
 * A missing USER attempt is then stored as not-submitted and claimed before respond.
 */
export async function continuePendingRimAi(
  tools: PendingRimAiTools &
    Readonly<{
      origin: AskRimOrigin | null;
    }>,
): Promise<ApplicationExecutionResult | null> {
  const initialized = await ensureInitialization(tools);
  if (initialized) {
    return initialized;
  }
  return reconcile(
    {
      ...tools,
      mode: "live",
      origin: { kind: "effect", value: tools.origin },
      inFlightRequestIds: [],
    },
    0,
  );
}

/**
 * Recovers Conversation initialization, then a durable PENDING logical request.
 * Does not create a Product request, append a USER message, or dispatch E-52 or E-54.
 * Recovery does not create a missing USER attempt.
 */
export async function recoverPendingRimAi(
  tools: PendingRimAiTools &
    Readonly<{
      inFlightRequestIds?: readonly string[];
    }>,
): Promise<ApplicationExecutionResult | null> {
  const initialized = await ensureInitialization(tools);
  if (initialized) {
    return initialized;
  }
  return reconcile(
    {
      context: tools.context,
      ...(tools.clientClaimedUserId === undefined
        ? {}
        : { clientClaimedUserId: tools.clientClaimedUserId }),
      deps: tools.deps,
      rimAi: tools.rimAi,
      ...(tools.conversation === undefined ? {} : { conversation: tools.conversation }),
      ...(tools.initializationLog === undefined
        ? {}
        : { initializationLog: tools.initializationLog }),
      retrieval: tools.retrieval,
      mode: "recover",
      origin: { kind: "current" },
      inFlightRequestIds: tools.inFlightRequestIds ?? [],
    },
    0,
  );
}

async function ensureInitialization(
  tools: PendingRimAiTools,
): Promise<ApplicationExecutionResult | null> {
  return reconcileRimInitialization({
    context: tools.context,
    ...(tools.clientClaimedUserId === undefined
      ? {}
      : { clientClaimedUserId: tools.clientClaimedUserId }),
    deps: tools.deps,
    rimAi: tools.rimAi,
    ...(tools.conversation === undefined ? {} : { conversation: tools.conversation }),
    ...(tools.initializationLog === undefined
      ? {}
      : { initializationLog: tools.initializationLog }),
  });
}

async function reconcile(
  tools: ReconcileTools,
  reentry: number,
): Promise<ApplicationExecutionResult | null> {
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const pending = pendingChat(loaded.snapshot);
  if (!pending) {
    return null;
  }
  if (tools.mode === "recover" && tools.inFlightRequestIds.includes(pending.snapshot.requestId)) {
    return null;
  }
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  if (parsed.status === "INVALID") {
    return null;
  }
  const applicable =
    parsed.status === "PRESENT" ? applicableRimProviderRuntime(parsed, pending.chat.id) : null;
  if (
    !applicable ||
    !applicable.attempt ||
    applicable.attempt.requestId !== pending.snapshot.requestId
  ) {
    if (tools.mode !== "live") {
      return null;
    }
    const created = attemptOnStoredInitialization(pending, tools.deps.allocateId, applicable);
    if (!created) {
      return null;
    }
    const saved = await trySave(tools, loaded.revision, created);
    if (!saved.ok) {
      return reentry >= MAX_CLAIM_REENTRY ? null : reconcile(tools, reentry + 1);
    }
    return claimThenSubmit(tools, saved.loaded, created, reentry);
  }
  if (applicable.initialization.submissionState !== "stored") {
    return null;
  }
  if (applicable.attempt.submissionState === "not-submitted") {
    return claimThenSubmit(tools, loaded, applicable, reentry);
  }
  if (applicable.attempt.submissionState === "acceptance-unknown") {
    return null;
  }
  return retrieveThenComplete(tools, loaded, applicable, applicable.attempt.responseId);
}

async function claimThenSubmit(
  tools: ReconcileTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  reentry: number,
): Promise<ApplicationExecutionResult | null> {
  if (runtime.attempt?.submissionState !== "not-submitted") {
    return null;
  }
  const claimed = withAttempt(runtime, {
    requestId: runtime.attempt.requestId,
    attemptId: runtime.attempt.attemptId,
    submissionState: "acceptance-unknown",
    clientRequestId: runtime.attempt.clientRequestId,
  });
  const saved = await trySave(tools, loaded.revision, claimed);
  if (!saved.ok) {
    return reentry >= MAX_CLAIM_REENTRY
      ? null
      : reconcile({ ...tools, mode: "recover" }, reentry + 1);
  }
  const pending = pendingChat(saved.loaded.snapshot);
  if (!pending || pending.snapshot.requestId !== claimed.attempt?.requestId) {
    return null;
  }
  return submitClaimed(tools, pending, saved.loaded.snapshot, claimed);
}

async function submitClaimed(
  tools: ReconcileTools,
  pending: PendingChat,
  snapshot: ProductSnapshot,
  runtime: RimProviderRuntime,
): Promise<ApplicationExecutionResult | null> {
  if (runtime.initialization.submissionState !== "stored") {
    return null;
  }
  const data =
    pending.chat.relationshipContext?.status === "ready"
      ? pending.chat.relationshipContext.data
      : null;
  const origin =
    tools.origin.kind === "effect"
      ? tools.origin.value
      : validAskRimOrigin(snapshot, tools.context.currentUserId);
  let event: ProductEventInput;
  try {
    const result = await tools.rimAi.respond(
      providerRequest(
        pending,
        data ?? EMPTY_CONTEXT,
        origin,
        runtime.initialization.conversationId,
      ),
    );
    event = completionEvent(pending.snapshot, result);
  } catch (error) {
    const failure =
      error instanceof FakeRimAiFailure
        ? error.failure
        : ({
            code: "RIM_AI_FAILED",
            message: error instanceof Error ? error.message : "rim ai failed",
          } as unknown as Failure);
    event = failureEvent(pending.snapshot, failure);
  }
  return dispatch(tools, event);
}

async function retrieveThenComplete(
  tools: ReconcileTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  responseId: ProviderResponseId,
): Promise<ApplicationExecutionResult | null> {
  if (!tools.retrieval) {
    return null;
  }
  const retrieved = await tools.retrieval.retrieve(responseId);
  if (!retrieved || retrieved.responseId !== responseId) {
    return null;
  }
  const attempt = runtime.attempt;
  if (!attempt) {
    return null;
  }
  const observed = withAttempt(runtime, {
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    submissionState: "completed-retrieved",
    responseId,
    providerStatus: retrieved.providerStatus,
    clientRequestId: attempt.clientRequestId,
  });
  const saved = await trySave(tools, loaded.revision, observed);
  const fresh = saved.loaded;
  const pending = pendingChat(fresh.snapshot);
  if (!pending || pending.snapshot.requestId !== attempt.requestId) {
    return null;
  }
  return completeRetrieved(tools, pending, retrieved.providerStatus, retrieved.output);
}

async function completeRetrieved(
  tools: ReconcileTools,
  pending: PendingChat,
  status: RetrievedProviderStatus,
  output: unknown,
): Promise<ApplicationExecutionResult | null> {
  if (status === "queued" || status === "in_progress") {
    return null;
  }
  if (status === "failed" || status === "cancelled" || status === "incomplete") {
    return dispatch(
      tools,
      failureEvent(pending.snapshot, {
        code: "RIM_AI_FAILED",
        message: status,
      } as unknown as Failure),
    );
  }
  if (output === undefined) {
    return null;
  }
  return dispatch(tools, completionEvent(pending.snapshot, output));
}

function completionEvent(snapshot: RimRequestSnapshot, output: unknown): ProductEventInput {
  const validated = validateRimAiOutput(output);
  if (!validated.ok) {
    return failureEvent(snapshot, {
      code: RIM_AI_OUTPUT_INVALID,
      message: validated.reason,
    } as unknown as Failure);
  }
  return {
    name: "RIM.AI_RESULT_RECEIVED",
    payload: {
      rimChatId: snapshot.rimChatId,
      requestId: snapshot.requestId,
      result: validated.result,
    },
  };
}

function failureEvent(snapshot: RimRequestSnapshot, failure: Failure): ProductEventInput {
  return {
    name: "RIM.AI_REQUEST_FAILED",
    payload: {
      rimChatId: snapshot.rimChatId,
      requestId: snapshot.requestId,
      failure,
    },
  };
}

async function dispatch(
  tools: ReconcileTools,
  event: ProductEventInput,
): Promise<ApplicationExecutionResult> {
  return executeProductEvent(
    {
      context: tools.context,
      event,
      ...(tools.clientClaimedUserId === undefined
        ? {}
        : { clientClaimedUserId: tools.clientClaimedUserId }),
    },
    tools.deps,
  );
}

function pendingChat(snapshot: ProductSnapshot): PendingChat | null {
  if (snapshot.controlState !== "RIM.CHAT" && snapshot.controlState !== "RIM.SELECT_CONTACT") {
    return null;
  }
  if (snapshot.extended.savedFrozenRimChat !== null) {
    return null;
  }
  const chat = snapshot.extended.rimChat;
  if (!chat?.selectedContactId || chat.aiOperation.status !== "PENDING") {
    return null;
  }
  return { chat, snapshot: chat.aiOperation.snapshot };
}

function attemptOnStoredInitialization(
  pending: PendingChat,
  allocateId: ProductExecutorDependencies["allocateId"],
  existing: RimProviderRuntime | null,
): RimProviderRuntime | null {
  if (!existing || existing.initialization.submissionState !== "stored") {
    return null;
  }
  if (
    existing.rimChatId !== pending.chat.id ||
    existing.selectedContactId !== pending.chat.selectedContactId ||
    existing.contextRequestId !== pending.snapshot.contextRequestId
  ) {
    return null;
  }
  return withAttempt(existing, {
    requestId: pending.snapshot.requestId,
    attemptId: allocateId("rim-provider-attempt") as RimProviderAttemptId,
    submissionState: "not-submitted",
    clientRequestId: null,
  });
}

function withAttempt(runtime: RimProviderRuntime, attempt: RimProviderAttempt): RimProviderRuntime {
  return {
    rimChatId: runtime.rimChatId,
    selectedContactId: runtime.selectedContactId,
    contextRequestId: runtime.contextRequestId,
    initialization: runtime.initialization,
    attempt,
  };
}

function providerRequest(
  pending: PendingChat,
  relationshipContext: RelationshipContextData,
  conversationalOrigin: AskRimOrigin | null,
  conversationId: ProviderConversationId,
): RimAiRequest {
  return {
    requestId: pending.snapshot.requestId,
    rimChatId: pending.snapshot.rimChatId,
    conversationId,
    userMessage: pending.snapshot.userMessage,
    contextRequestId: pending.snapshot.contextRequestId,
    relationshipContext,
    messages: pending.chat.messages,
    conversationalOrigin,
  };
}

async function trySave(
  tools: ReconcileTools,
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

export function inFlightRimAiRequestIds(
  execution: ApplicationExecutionResult,
): readonly AiRequestId[] {
  return execution.pendingExternalEffects.flatMap((item) =>
    item.effect.type === "REQUEST_RIM_AI" ? [item.effect.requestId] : [],
  );
}
