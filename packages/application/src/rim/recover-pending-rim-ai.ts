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
import {
  projectLocalCanonicalHistory,
  type LocalRimAiRequest,
  type RimAiPort,
  type RimAiRequest,
} from "./rim-ai-port.ts";
import {
  PRODUCT_SEMANTICS_UNAVAILABLE,
  RIM_PROMPT_UNAVAILABLE,
  type RimConversationInitializationPort,
} from "./rim-conversation-port.ts";
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

/**
 * Process-local USER execution calls, keyed by user and technical attemptId.
 * The entry is registered before the acceptance-unknown claim is written and
 * cleared when that call exits, including its existing completion dispatch.
 * It is not persisted and it is not a Product fact. A restart drops it.
 * Initialization keeps its own separate flight map.
 */
const inFlightUserAttempts = new Map<string, Promise<void>>();

const AMBIGUOUS_PROVIDER_ATTEMPT = "ambiguous-provider-attempt";
const RETURNED_BODY_SAVE_CONFLICT = "returned-body-save-conflict";

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
 * An ambiguous provider USER attempt with no in-process flight is switched once
 * to local-canonical-history. That new not-submitted attempt is claimed and
 * executed from Application canonical history, without the stored conversation id.
 * A live provider throw with no durable responseId takes that same path and does
 * not dispatch E-59 for the provider call. A later local throw also does not
 * dispatch E-59: the same attempt stays acceptance-unknown and Product stays
 * PENDING. That unresolved local ambiguity is not a logical terminal failure.
 * A durably observed returned body is not that ambiguity, including after restart.
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
    if (ambiguousProviderUserAttempt(tools, pending, applicable)) {
      return transitionAmbiguousUserAttempt(tools, loaded, applicable, reentry);
    }
    return null;
  }
  if (applicable.attempt.submissionState === "returned-body-observed") {
    return null;
  }
  return retrieveThenComplete(tools, loaded, applicable, applicable.attempt.responseId);
}

/**
 * CAS predicate for the one provider → local transition.
 * Every fact is taken from the loaded Product snapshot and the applicable runtime.
 * The save itself commits only if that snapshot revision is still current.
 */
function ambiguousProviderUserAttempt(
  tools: ReconcileTools,
  pending: PendingChat,
  runtime: RimProviderRuntime,
): boolean {
  const attempt = runtime.attempt;
  if (!attempt || attempt.submissionState !== "acceptance-unknown") {
    return false;
  }
  if (runtime.continuityMode !== "provider-conversation") {
    return false;
  }
  if (runtime.initialization.submissionState !== "stored") {
    return false;
  }
  if (attempt.requestId !== pending.snapshot.requestId) {
    return false;
  }
  if (
    runtime.rimChatId !== pending.chat.id ||
    runtime.selectedContactId !== pending.chat.selectedContactId ||
    runtime.contextRequestId !== pending.snapshot.contextRequestId
  ) {
    return false;
  }
  return !inFlightUserAttempts.has(userFlightKey(tools.context.currentUserId, attempt.attemptId));
}

async function transitionAmbiguousUserAttempt(
  tools: ReconcileTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  reentry: number,
): Promise<ApplicationExecutionResult | null> {
  const current = runtime.attempt;
  const pending = pendingChat(loaded.snapshot);
  if (!current || !pending || !ambiguousProviderUserAttempt(tools, pending, runtime)) {
    return null;
  }
  const next: RimProviderRuntime = {
    rimChatId: runtime.rimChatId,
    selectedContactId: runtime.selectedContactId,
    contextRequestId: runtime.contextRequestId,
    initialization: runtime.initialization,
    attempt: {
      requestId: current.requestId,
      attemptId: tools.deps.allocateId("rim-provider-attempt") as RimProviderAttemptId,
      submissionState: "not-submitted",
      clientRequestId: null,
    },
    continuityMode: "local-canonical-history",
    retiredAttemptId: current.attemptId,
  };
  const saved = await trySave(tools, loaded.revision, next);
  if (!saved.ok) {
    return reentry >= MAX_CLAIM_REENTRY ? null : reconcile(tools, reentry + 1);
  }
  return claimThenSubmit(tools, saved.loaded, next, reentry);
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
  const pending = pendingChat(loaded.snapshot);
  if (!pending || pending.snapshot.requestId !== runtime.attempt.requestId) {
    return null;
  }
  const request = executionRequest(tools, pending, loaded, runtime);
  if (!request) {
    return null;
  }
  const key = userFlightKey(tools.context.currentUserId, runtime.attempt.attemptId);
  if (inFlightUserAttempts.has(key)) {
    return null;
  }
  // Reserve before the claim CAS yields. Otherwise a concurrent recovery can
  // observe acceptance-unknown with no flight and treat the live call as abandoned.
  let resolveFlight: () => void = () => undefined;
  const flight = new Promise<void>((resolve) => {
    resolveFlight = resolve;
  });
  inFlightUserAttempts.set(key, flight);
  let retry = false;
  let ambiguousFailure = false;
  let returnedBodyConflict = false;
  let result: ApplicationExecutionResult | null = null;
  try {
    const claimed = withAttempt(runtime, {
      requestId: runtime.attempt.requestId,
      attemptId: runtime.attempt.attemptId,
      submissionState: "acceptance-unknown",
      clientRequestId: runtime.attempt.clientRequestId,
    });
    const saved = await trySave(tools, loaded.revision, claimed);
    if (!saved.ok) {
      retry = true;
    } else {
      const pendingAfterClaim = pendingChat(saved.loaded.snapshot);
      if (
        pendingAfterClaim &&
        pendingAfterClaim.snapshot.requestId === claimed.attempt?.requestId
      ) {
        const submitted = await submitClaimed(
          tools,
          pendingAfterClaim,
          saved.loaded,
          claimed,
          request,
        );
        if (submitted === AMBIGUOUS_PROVIDER_ATTEMPT) {
          ambiguousFailure = true;
        } else if (submitted === RETURNED_BODY_SAVE_CONFLICT) {
          returnedBodyConflict = true;
        } else {
          result = submitted;
        }
      }
    }
  } finally {
    resolveFlight();
    if (inFlightUserAttempts.get(key) === flight) {
      inFlightUserAttempts.delete(key);
    }
  }
  if (retry) {
    return reentry >= MAX_CLAIM_REENTRY
      ? null
      : reconcile({ ...tools, mode: "recover" }, reentry + 1);
  }
  if (ambiguousFailure || returnedBodyConflict) {
    return reconcile(tools, reentry);
  }
  return result;
}

function userFlightKey(userId: string, attemptId: string): string {
  return `${userId}:${attemptId}`;
}

async function submitClaimed(
  tools: ReconcileTools,
  pending: PendingChat,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  request: RimAiRequest,
): Promise<
  | ApplicationExecutionResult
  | typeof AMBIGUOUS_PROVIDER_ATTEMPT
  | typeof RETURNED_BODY_SAVE_CONFLICT
  | null
> {
  if (runtime.initialization.submissionState !== "stored") {
    return null;
  }
  let body: unknown;
  try {
    body = await tools.rimAi.respond(request);
  } catch (error) {
    if (ambiguousClaim(runtime)) {
      return AMBIGUOUS_PROVIDER_ATTEMPT;
    }
    if (runtime.continuityMode === "local-canonical-history") {
      return null;
    }
    const failure =
      error instanceof FakeRimAiFailure
        ? error.failure
        : ({
            code: "RIM_AI_FAILED",
            message: error instanceof Error ? error.message : "rim ai failed",
          } as unknown as Failure);
    return dispatch(tools, failureEvent(pending.snapshot, failure));
  }
  const observed = await persistReturnedBody(tools, loaded, runtime);
  if (!observed.ok) {
    return RETURNED_BODY_SAVE_CONFLICT;
  }
  const current = pendingChat(observed.loaded.snapshot);
  const attempt = runtime.attempt;
  if (!current || !attempt || current.snapshot.requestId !== attempt.requestId) {
    return null;
  }
  return dispatch(tools, completionEvent(current.snapshot, body));
}

async function persistReturnedBody(
  tools: ReconcileTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
): Promise<{ ok: true; loaded: LoadedSnapshot } | { ok: false }> {
  const attempt = runtime.attempt;
  if (!attempt || attempt.submissionState !== "acceptance-unknown") {
    return { ok: false };
  }
  return trySave(
    tools,
    loaded.revision,
    withAttempt(runtime, {
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      submissionState: "returned-body-observed",
      clientRequestId: attempt.clientRequestId,
    }),
  );
}

function ambiguousClaim(runtime: RimProviderRuntime): boolean {
  return (
    runtime.continuityMode === "provider-conversation" &&
    runtime.initialization.submissionState === "stored" &&
    runtime.attempt?.submissionState === "acceptance-unknown"
  );
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
    continuityMode: runtime.continuityMode,
    retiredAttemptId: runtime.retiredAttemptId,
  };
}

function executionRequest(
  tools: ReconcileTools,
  pending: PendingChat,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
): RimAiRequest | null {
  if (runtime.initialization.submissionState !== "stored") {
    return null;
  }
  if (runtime.continuityMode === "local-canonical-history") {
    const frozen = exactFrozenContext(pending, runtime);
    if (!frozen) {
      return null;
    }
    return localRequest(pending, frozen);
  }
  const data =
    pending.chat.relationshipContext?.status === "ready"
      ? pending.chat.relationshipContext.data
      : null;
  const origin =
    tools.origin.kind === "effect"
      ? tools.origin.value
      : validAskRimOrigin(loaded.snapshot, tools.context.currentUserId);
  return providerRequest(
    pending,
    data ?? EMPTY_CONTEXT,
    origin,
    runtime.initialization.conversationId,
  );
}

/**
 * The frozen ready payload for this RimChat.
 * A local attempt does not rebuild context and does not borrow an empty payload.
 */
function exactFrozenContext(
  pending: PendingChat,
  runtime: RimProviderRuntime,
): RelationshipContextData | null {
  const context = pending.chat.relationshipContext;
  if (!context || context.status !== "ready" || context.data === null) {
    return null;
  }
  if (
    pending.chat.id !== runtime.rimChatId ||
    pending.chat.selectedContactId !== runtime.selectedContactId ||
    context.selectedContactId !== runtime.selectedContactId ||
    context.requestId !== runtime.contextRequestId ||
    context.requestId !== pending.snapshot.contextRequestId
  ) {
    return null;
  }
  return context.data;
}

function localRequest(
  pending: PendingChat,
  relationshipContext: RelationshipContextData,
): LocalRimAiRequest {
  return {
    continuityMode: "local-canonical-history",
    requestId: pending.snapshot.requestId,
    rimChatId: pending.snapshot.rimChatId,
    contextRequestId: pending.snapshot.contextRequestId,
    relationshipContext,
    conversationalOrigin: pending.chat.askRimOrigin,
    rimPrompt: RIM_PROMPT_UNAVAILABLE,
    productSemantics: PRODUCT_SEMANTICS_UNAVAILABLE,
    canonicalHistory: projectLocalCanonicalHistory(pending.chat.messages),
  };
}

function providerRequest(
  pending: PendingChat,
  relationshipContext: RelationshipContextData,
  conversationalOrigin: AskRimOrigin | null,
  conversationId: ProviderConversationId,
): RimAiRequest {
  return {
    continuityMode: "provider-conversation",
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
