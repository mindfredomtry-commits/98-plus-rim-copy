import { emitDiagnostic } from "@98plus/diagnostics";
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
import { commitProductEventIfAttemptCurrent } from "../execute.ts";
import {
  RIM_OWNERSHIP_LEASE_SECONDS,
  rimOwnershipRecoveryPermitted,
  startRimOwnershipHeartbeat,
} from "./rim-ownership-lease.ts";
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
  type RimResponseCreatedObservation,
} from "./rim-ai-port.ts";
import {
  providerReadySemanticInputs,
  type RimConversationInitializationPort,
} from "./rim-conversation-port.ts";
import type { RimProviderRetrievalPort } from "./rim-provider-retrieval.ts";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type ProviderResponseId,
  type RetrievedProviderStatus,
  terminalUnusableAttempt,
  type RimProviderAttempt,
  type RimProviderAttemptId,
  type RimProviderRuntime,
  type RimRetryIntent,
} from "./rim-provider-runtime.ts";
import { RIM_AI_OUTPUT_INVALID, validateRimAiOutput } from "./validate-rim-ai-output.ts";

const MAX_CLAIM_REENTRY = 1;

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

type ProducingAttempt = Readonly<{
  rimChatId: RimProviderRuntime["rimChatId"];
  selectedContactId: RimProviderRuntime["selectedContactId"];
  contextRequestId: RimProviderRuntime["contextRequestId"];
  requestId: AiRequestId;
  attemptId: RimProviderAttemptId;
  continuityMode: RimProviderRuntime["continuityMode"];
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
  await emitRimRequestStarted(tools);
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
 * An ambiguous provider USER attempt is switched once to local-canonical-history
 * only when durable ownership permits Class C or Class U recovery, or when the
 * owning process observed the provider failure. A held lease does not install a
 * successor. The new not-submitted attempt is claimed and executed from
 * Application canonical history, without the stored conversation id.
 * A live provider throw with no durable responseId takes that same path and does
 * not dispatch E-59 for the provider call. A later local throw also does not
 * dispatch E-59: the same attempt stays acceptance-unknown and Product stays
 * PENDING. That unresolved local ambiguity is not a logical terminal failure.
 * A Response id observed before semantic completion is CAS-written as
 * response-id-known and is never erased. A throw after that id does not fall
 * back and does not dispatch E-59. A second, different Response id in the same
 * live call makes that call's body non-authoritative: resp-A stays
 * response-id-known, and the body is not validated. A durably observed returned
 * body is not acceptance-unknown ambiguity, including after restart.
 * A durable response id is recovered by retrieve, including a returned body
 * that retained that id. A historical returned body with no response id is not
 * retrieved. A retrieval result dispatches only after its observation CAS
 * commits for this attempt.
 * An accepted E-54 records retry intent in that same commit. Recovery uses
 * that intent to install one replacement local attempt, then clears it.
 * E-58 and E-59 commit only while the producing attempt still owns the session.
 */
export async function recoverPendingRimAi(
  tools: PendingRimAiTools &
    Readonly<{
      inFlightRequestIds?: readonly string[];
    }>,
): Promise<ApplicationExecutionResult | null> {
  await emitRimRequestStarted(tools);
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

/**
 * Entry diagnostic for live continuation and recovery re-entry.
 * correlationId comes from ALS (not durable across process restart).
 * requestId is included when a PENDING chat is already present for linkage.
 */
async function emitRimRequestStarted(tools: PendingRimAiTools): Promise<void> {
  let requestId: string | undefined;
  try {
    const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
    requestId = pendingChat(loaded.snapshot)?.snapshot.requestId;
  } catch {
    requestId = undefined;
  }
  emitDiagnostic({
    eventName: "rim.request.started",
    source: "rim",
    meta: {
      actorId: tools.context.currentUserId,
      ...(requestId === undefined ? {} : { requestId }),
    },
  });
}

function failureCodeOf(failure: Failure): string {
  return String((failure as { code?: string }).code ?? "");
}

function isTimeoutFailure(failure: Failure): boolean {
  return failureCodeOf(failure).toLowerCase().includes("timeout");
}

/**
 * Adapter-reported timeout when Product does not dispatch E-59
 * (ambiguous provider claim / local throw leave PENDING). Diagnostic-only.
 */
function emitTimeoutWithoutProductFailure(
  tools: ReconcileTools,
  runtime: RimProviderRuntime,
  failure: Failure,
): void {
  const authority = producingAttempt(runtime);
  if (!authority) {
    return;
  }
  const failureCode = failureCodeOf(failure);
  emitDiagnostic({
    eventName: "rim.request.timeout",
    source: "rim",
    meta: {
      classification: "AI_TIMEOUT",
      requestId: authority.requestId,
      attemptId: authority.attemptId,
      actorId: tools.context.currentUserId,
      ...(failureCode.length > 0 ? { errorCode: failureCode.slice(0, 64) } : {}),
    },
  });
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
    if (ambiguousProviderUserAttempt(pending, applicable)) {
      return transitionAmbiguousUserAttempt(tools, applicable, reentry);
    }
    return null;
  }
  if (acceptedDurableRetry(pending, applicable)) {
    return retryTerminalAttemptLocally(tools, loaded, applicable, reentry);
  }
  if (applicable.attempt.submissionState === "returned-body-observed") {
    if (applicable.attempt.responseId === undefined) {
      return null;
    }
    return retrieveThenComplete(tools, loaded, applicable, applicable.attempt.responseId);
  }
  return retrieveThenComplete(tools, loaded, applicable, applicable.attempt.responseId);
}

/**
 * Shape of the one provider → local transition.
 * Durable ownership, rechecked under the session lock, decides whether it runs.
 */
function ambiguousProviderUserAttempt(pending: PendingChat, runtime: RimProviderRuntime): boolean {
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
  return (
    runtime.rimChatId === pending.chat.id &&
    runtime.selectedContactId === pending.chat.selectedContactId &&
    runtime.contextRequestId === pending.snapshot.contextRequestId
  );
}

async function transitionAmbiguousUserAttempt(
  tools: ReconcileTools,
  runtime: RimProviderRuntime,
  reentry: number,
  ownerToken?: string,
): Promise<ApplicationExecutionResult | null> {
  const retiredAttemptId = runtime.attempt?.attemptId;
  if (!retiredAttemptId) {
    return null;
  }
  const replaced = await tools.deps.store.withRimProviderOwnershipCoordination(
    {
      currentUserId: tools.context.currentUserId,
      operationKind: "user-attempt",
      attemptId: retiredAttemptId,
    },
    async (coordination) => {
      const loaded = await coordination.load();
      const pending = pendingChat(loaded.snapshot);
      const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
      const applicable =
        parsed.status === "PRESENT" && pending
          ? applicableRimProviderRuntime(parsed, pending.chat.id)
          : null;
      if (!pending || !applicable || !ambiguousProviderUserAttempt(pending, applicable)) {
        return null;
      }
      if (!rimOwnershipRecoveryPermitted(coordination.ownership, ownerToken)) {
        return null;
      }
      const current = applicable.attempt;
      if (!current) {
        return null;
      }
      const next: RimProviderRuntime = {
        rimChatId: applicable.rimChatId,
        selectedContactId: applicable.selectedContactId,
        contextRequestId: applicable.contextRequestId,
        initialization: applicable.initialization,
        attempt: {
          requestId: current.requestId,
          attemptId: tools.deps.allocateId("rim-provider-attempt") as RimProviderAttemptId,
          submissionState: "not-submitted",
          clientRequestId: null,
        },
        continuityMode: "local-canonical-history",
        retiredAttemptId: current.attemptId,
      };
      if (coordination.ownership && coordination.ownership.phase !== "released") {
        await coordination.invalidate("superseded");
      }
      const saved = await coordination.replaceRuntime(next);
      return { loaded: saved, runtime: next };
    },
  );
  if (!replaced) {
    return null;
  }
  return claimThenSubmit(tools, replaced.loaded, replaced.runtime, reentry);
}

function acceptedDurableRetry(pending: PendingChat, runtime: RimProviderRuntime): boolean {
  const attempt = runtime.attempt;
  const intent = runtime.retryIntent;
  if (!attempt || !intent || runtime.initialization.submissionState !== "stored") {
    return false;
  }
  if (!terminalUnusableAttempt(attempt)) {
    return false;
  }
  return (
    intent.rimChatId === runtime.rimChatId &&
    intent.rimChatId === pending.chat.id &&
    intent.contextRequestId === runtime.contextRequestId &&
    intent.contextRequestId === pending.snapshot.contextRequestId &&
    intent.requestId === attempt.requestId &&
    intent.requestId === pending.snapshot.requestId &&
    intent.attemptId === attempt.attemptId &&
    runtime.selectedContactId === pending.chat.selectedContactId
  );
}

/**
 * Explicit E-54 after a terminal unusable attempt.
 * The same RimChat, logical request, initialization, and semantic USER stay.
 * The technical attempt is replaced and continuity becomes local, including
 * when it was already local. The stored Conversation id is not sent or deleted.
 */
async function retryTerminalAttemptLocally(
  tools: ReconcileTools,
  loaded: LoadedSnapshot,
  runtime: RimProviderRuntime,
  reentry: number,
): Promise<ApplicationExecutionResult | null> {
  const current = runtime.attempt;
  const pending = pendingChat(loaded.snapshot);
  if (!current || !pending || !acceptedDurableRetry(pending, runtime)) {
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
  const claimed = withAttempt(runtime, {
    requestId: runtime.attempt.requestId,
    attemptId: runtime.attempt.attemptId,
    submissionState: "acceptance-unknown",
    clientRequestId: runtime.attempt.clientRequestId,
  });
  const claimedAttempt = claimed.attempt;
  if (!claimedAttempt) {
    return null;
  }
  let acquired: Awaited<
    ReturnType<ProductExecutorDependencies["store"]["acquireRimProviderOwnership"]>
  >;
  try {
    acquired = await tools.deps.store.acquireRimProviderOwnership({
      currentUserId: tools.context.currentUserId,
      expectedRevision: loaded.revision,
      runtime: claimed,
      operationKind: "user-attempt",
      attemptId: claimedAttempt.attemptId,
      requestId: claimedAttempt.requestId,
      leaseSeconds: RIM_OWNERSHIP_LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "REVISION_CONFLICT") {
      return reentry >= MAX_CLAIM_REENTRY
        ? null
        : reconcile({ ...tools, mode: "recover" }, reentry + 1);
    }
    throw error;
  }
  if (acquired.status === "ALREADY_PRESENT") {
    const finishedOtherRequest =
      acquired.ownership.phase === "released" &&
      acquired.ownership.releaseReason === "completed" &&
      acquired.ownership.requestId !== claimedAttempt.requestId;
    if (finishedOtherRequest && reentry < MAX_CLAIM_REENTRY) {
      const fresh = withAttempt(runtime, {
        requestId: claimedAttempt.requestId,
        attemptId: tools.deps.allocateId("rim-provider-attempt") as RimProviderAttemptId,
        submissionState: "not-submitted",
        clientRequestId: null,
      });
      const current = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
      const saved = await trySave(tools, current.revision, fresh);
      if (!saved.ok) {
        return reconcile({ ...tools, mode: "recover" }, reentry + 1);
      }
      return claimThenSubmit(tools, saved.loaded, fresh, reentry + 1);
    }
    return reentry >= MAX_CLAIM_REENTRY
      ? null
      : reconcile({ ...tools, mode: "recover" }, reentry + 1);
  }
  const ownerToken = acquired.ownership.ownerToken;
  const stopHeartbeat = startRimOwnershipHeartbeat(tools.deps.store, {
    currentUserId: tools.context.currentUserId,
    operationKind: "user-attempt",
    attemptId: claimedAttempt.attemptId,
    ownerToken,
  });
  let ambiguousFailure = false;
  let returnedBodyConflict = false;
  let result: ApplicationExecutionResult | null = null;
  try {
    const pendingAfterClaim = pendingChat(acquired.loaded.snapshot);
    if (pendingAfterClaim && pendingAfterClaim.snapshot.requestId === claimedAttempt.requestId) {
      const submitted = await submitClaimed(tools, pendingAfterClaim, claimed, request);
      if (submitted === AMBIGUOUS_PROVIDER_ATTEMPT) {
        ambiguousFailure = true;
      } else if (submitted === RETURNED_BODY_SAVE_CONFLICT) {
        returnedBodyConflict = true;
      } else {
        result = submitted;
      }
    }
  } finally {
    stopHeartbeat();
  }
  if (ambiguousFailure) {
    return transitionAmbiguousUserAttempt(tools, claimed, reentry, ownerToken);
  }
  if (returnedBodyConflict) {
    return reconcile(tools, reentry);
  }
  if (result?.persisted) {
    await tools.deps.store
      .releaseRimProviderOwnership({
        currentUserId: tools.context.currentUserId,
        operationKind: "user-attempt",
        attemptId: claimedAttempt.attemptId,
        ownerToken,
        releaseReason: "completed",
      })
      .catch(() => undefined);
  }
  return result;
}

async function submitClaimed(
  tools: ReconcileTools,
  pending: PendingChat,
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
  const provenance = createLiveResponseTracker();
  try {
    body = await tools.rimAi.respond(request, {
      onResponseCreated: async (responseId) => {
        const observation = await acceptResponseCreated(tools, pending, runtime, responseId);
        provenance.note(responseId, observation.accepted);
        return observation;
      },
    });
  } catch (error) {
    const observed = provenance.read();
    if (observed.kind === "conflict" || observed.kind === "accepted") {
      if (error instanceof FakeRimAiFailure && isTimeoutFailure(error.failure)) {
        emitTimeoutWithoutProductFailure(tools, runtime, error.failure);
      }
      return null;
    }
    const identity = await responseIdentityAfterThrow(tools, runtime);
    if (identity !== "unknown") {
      if (error instanceof FakeRimAiFailure && isTimeoutFailure(error.failure)) {
        emitTimeoutWithoutProductFailure(tools, runtime, error.failure);
      }
      return null;
    }
    if (ambiguousClaim(runtime)) {
      if (error instanceof FakeRimAiFailure && isTimeoutFailure(error.failure)) {
        emitTimeoutWithoutProductFailure(tools, runtime, error.failure);
      }
      return AMBIGUOUS_PROVIDER_ATTEMPT;
    }
    if (runtime.continuityMode === "local-canonical-history") {
      if (error instanceof FakeRimAiFailure && isTimeoutFailure(error.failure)) {
        emitTimeoutWithoutProductFailure(tools, runtime, error.failure);
      }
      return null;
    }
    const failure =
      error instanceof FakeRimAiFailure
        ? error.failure
        : ({
            code: "RIM_AI_FAILED",
            message: error instanceof Error ? error.message : "rim ai failed",
          } as unknown as Failure);
    const authority = producingAttempt(runtime);
    if (!authority) {
      return null;
    }
    return dispatchIfCurrent(tools, failureEvent(pending.snapshot, failure), authority);
  }
  const observedProvenance = provenance.read();
  if (observedProvenance.kind === "conflict" || observedProvenance.kind === "refused") {
    return null;
  }
  const observed = await persistReturnedBody(
    tools,
    runtime,
    observedProvenance.kind === "accepted" ? observedProvenance.responseId : null,
  );
  if (!observed.ok) {
    return observed.reason === "conflict" ? RETURNED_BODY_SAVE_CONFLICT : null;
  }
  const current = pendingChat(observed.loaded.snapshot);
  const attempt = runtime.attempt;
  const authority = producingAttempt(runtime);
  if (!current || !attempt || !authority || current.snapshot.requestId !== attempt.requestId) {
    return null;
  }
  return dispatchIfCurrent(tools, completionEvent(current.snapshot, body), authority);
}

async function acceptResponseCreated(
  tools: ReconcileTools,
  pending: PendingChat,
  claimed: RimProviderRuntime,
  responseId: ProviderResponseId,
): Promise<RimResponseCreatedObservation> {
  const claimedAttempt = claimed.attempt;
  if (!claimedAttempt || !nonEmptyResponseId(responseId)) {
    return { accepted: false };
  }
  const decision = await responseCreatedDecision(tools, pending, claimed, responseId);
  if (decision.kind !== "save") {
    return { accepted: decision.kind === "idempotent" };
  }
  const saved = await trySave(tools, decision.revision, decision.runtime);
  if (saved.ok) {
    return { accepted: true };
  }
  const again = await responseCreatedDecision(tools, pending, claimed, responseId);
  if (again.kind !== "save") {
    return { accepted: again.kind === "idempotent" };
  }
  const retried = await trySave(tools, again.revision, again.runtime);
  return { accepted: retried.ok };
}

async function responseCreatedDecision(
  tools: ReconcileTools,
  pending: PendingChat,
  claimed: RimProviderRuntime,
  responseId: ProviderResponseId,
): Promise<
  | { kind: "save"; revision: number; runtime: RimProviderRuntime }
  | { kind: "idempotent" }
  | { kind: "reject" }
> {
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const current = pendingChat(loaded.snapshot);
  const claimedAttempt = claimed.attempt;
  if (!current || !claimedAttempt) {
    return { kind: "reject" };
  }
  if (
    current.chat.id !== pending.chat.id ||
    current.snapshot.requestId !== pending.snapshot.requestId ||
    current.snapshot.requestId !== claimedAttempt.requestId
  ) {
    return { kind: "reject" };
  }
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  const applicable =
    parsed.status === "PRESENT" ? applicableRimProviderRuntime(parsed, current.chat.id) : null;
  if (!applicable || !sameRuntimeIdentity(claimed, applicable)) {
    return { kind: "reject" };
  }
  const attempt = applicable.attempt;
  if (!attempt || attempt.attemptId !== claimedAttempt.attemptId) {
    return { kind: "reject" };
  }
  if (attempt.requestId !== claimedAttempt.requestId) {
    return { kind: "reject" };
  }
  if (attempt.submissionState === "response-id-known") {
    return attempt.responseId === responseId ? { kind: "idempotent" } : { kind: "reject" };
  }
  if (attempt.submissionState !== "acceptance-unknown") {
    return { kind: "reject" };
  }
  return {
    kind: "save",
    revision: loaded.revision,
    runtime: withAttempt(applicable, {
      requestId: attempt.requestId,
      attemptId: attempt.attemptId,
      submissionState: "response-id-known",
      responseId,
      clientRequestId: attempt.clientRequestId,
    }),
  };
}

async function responseIdentityAfterThrow(
  tools: ReconcileTools,
  claimed: RimProviderRuntime,
): Promise<"known" | "unknown" | "unreadable"> {
  const claimedAttempt = claimed.attempt;
  if (!claimedAttempt) {
    return "unreadable";
  }
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  if (parsed.status !== "PRESENT") {
    return parsed.status === "INVALID" ? "unreadable" : "unknown";
  }
  const attempt = parsed.runtime.attempt;
  if (!attempt || attempt.attemptId !== claimedAttempt.attemptId) {
    return "unknown";
  }
  if (attempt.requestId !== claimedAttempt.requestId) {
    return "unknown";
  }
  if (attempt.submissionState === "response-id-known") {
    return "known";
  }
  if (attempt.submissionState === "returned-body-observed" && attempt.responseId !== undefined) {
    return "known";
  }
  return "unknown";
}

/**
 * Process-local identity of one respond() call.
 * A conflicting second id discards that call's body. It is not a Product state:
 * the first durable response-id-known row remains the recovery anchor.
 */
type LiveResponseProvenance =
  | { readonly kind: "unobserved" }
  | { readonly kind: "refused" }
  | { readonly kind: "accepted"; readonly responseId: ProviderResponseId }
  | { readonly kind: "conflict"; readonly responseId: ProviderResponseId };

function createLiveResponseTracker(): {
  note(responseId: ProviderResponseId, accepted: boolean): void;
  read(): LiveResponseProvenance;
} {
  let current: LiveResponseProvenance = { kind: "unobserved" };
  return {
    note(responseId, accepted) {
      current = noteLiveResponse(current, responseId, accepted);
    },
    read() {
      return current;
    },
  };
}

function noteLiveResponse(
  current: LiveResponseProvenance,
  responseId: ProviderResponseId,
  accepted: boolean,
): LiveResponseProvenance {
  if (current.kind === "conflict") {
    return current;
  }
  if (current.kind === "accepted") {
    return responseId === current.responseId
      ? current
      : { kind: "conflict", responseId: current.responseId };
  }
  if (accepted) {
    return { kind: "accepted", responseId };
  }
  return { kind: "refused" };
}

async function persistReturnedBody(
  tools: ReconcileTools,
  claimed: RimProviderRuntime,
  authoritativeResponseId: ProviderResponseId | null,
): Promise<{ ok: true; loaded: LoadedSnapshot } | { ok: false; reason: "conflict" | "rejected" }> {
  const claimedAttempt = claimed.attempt;
  if (!claimedAttempt) {
    return { ok: false, reason: "rejected" };
  }
  const loaded = await tools.deps.store.loadProductSnapshot(tools.context.currentUserId);
  const current = pendingChat(loaded.snapshot);
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  const applicable =
    parsed.status === "PRESENT" && current
      ? applicableRimProviderRuntime(parsed, current.chat.id)
      : null;
  const attempt = applicable?.attempt;
  if (!current || !applicable || !attempt || !sameRuntimeIdentity(claimed, applicable)) {
    return { ok: false, reason: "rejected" };
  }
  if (
    attempt.attemptId !== claimedAttempt.attemptId ||
    attempt.requestId !== claimedAttempt.requestId ||
    current.snapshot.requestId !== claimedAttempt.requestId
  ) {
    return { ok: false, reason: "rejected" };
  }
  const observed =
    authoritativeResponseId === null
      ? attempt.submissionState === "acceptance-unknown"
        ? {
            requestId: attempt.requestId,
            attemptId: attempt.attemptId,
            submissionState: "returned-body-observed" as const,
            clientRequestId: attempt.clientRequestId,
          }
        : null
      : attempt.submissionState === "response-id-known" &&
          attempt.responseId === authoritativeResponseId
        ? {
            requestId: attempt.requestId,
            attemptId: attempt.attemptId,
            submissionState: "returned-body-observed" as const,
            responseId: authoritativeResponseId,
            clientRequestId: attempt.clientRequestId,
          }
        : null;
  if (!observed) {
    return { ok: false, reason: "rejected" };
  }
  const saved = await trySave(tools, loaded.revision, withAttempt(applicable, observed));
  return saved.ok ? saved : { ok: false, reason: "conflict" };
}

function sameRuntimeIdentity(claimed: RimProviderRuntime, loaded: RimProviderRuntime): boolean {
  if (
    claimed.rimChatId !== loaded.rimChatId ||
    claimed.selectedContactId !== loaded.selectedContactId ||
    claimed.contextRequestId !== loaded.contextRequestId ||
    claimed.continuityMode !== loaded.continuityMode ||
    claimed.retiredAttemptId !== loaded.retiredAttemptId ||
    !sameRetryIntent(claimed.retryIntent, loaded.retryIntent)
  ) {
    return false;
  }
  const left = claimed.initialization;
  const right = loaded.initialization;
  if (left.submissionState !== right.submissionState || left.attemptId !== right.attemptId) {
    return false;
  }
  if (left.submissionState === "stored" && right.submissionState === "stored") {
    return left.conversationId === right.conversationId;
  }
  return true;
}

function nonEmptyResponseId(value: ProviderResponseId): boolean {
  return typeof value === "string" && value.length > 0;
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
  const retrievalPort = tools.retrieval;
  let retrieved: Awaited<ReturnType<RimProviderRetrievalPort["retrieve"]>>;
  try {
    retrieved = await retrievalPort.retrieve(responseId);
  } catch {
    return null;
  }
  if (!retrieved || retrieved.responseId !== responseId) {
    return null;
  }
  const attempt = runtime.attempt;
  if (!attempt || !("responseId" in attempt) || attempt.responseId !== responseId) {
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
  if (!saved.ok) {
    return null;
  }
  if (!retrievalObservationAccepted(saved.loaded, runtime, responseId, retrieved.providerStatus)) {
    return null;
  }
  const pending = pendingChat(saved.loaded.snapshot);
  const authority = producingAttempt(runtime);
  if (!pending || !authority) {
    return null;
  }
  return completeRetrieved(tools, pending, retrieved.providerStatus, retrieved.output, authority);
}

function retrievalObservationAccepted(
  loaded: LoadedSnapshot,
  claimed: RimProviderRuntime,
  responseId: ProviderResponseId,
  providerStatus: RetrievedProviderStatus,
): boolean {
  const pending = pendingChat(loaded.snapshot);
  const claimedAttempt = claimed.attempt;
  if (!pending || !claimedAttempt || pending.chat.id !== claimed.rimChatId) {
    return false;
  }
  if (pending.snapshot.requestId !== claimedAttempt.requestId) {
    return false;
  }
  const parsed = parseRimProviderRuntime(loaded.rimProviderRuntime);
  const applicable =
    parsed.status === "PRESENT" ? applicableRimProviderRuntime(parsed, pending.chat.id) : null;
  if (!applicable || !sameRuntimeIdentity(claimed, applicable)) {
    return false;
  }
  const attempt = applicable.attempt;
  return (
    !!attempt &&
    attempt.submissionState === "completed-retrieved" &&
    attempt.attemptId === claimedAttempt.attemptId &&
    attempt.requestId === claimedAttempt.requestId &&
    pending.snapshot.requestId === attempt.requestId &&
    attempt.responseId === responseId &&
    attempt.providerStatus === providerStatus
  );
}

async function completeRetrieved(
  tools: ReconcileTools,
  pending: PendingChat,
  status: RetrievedProviderStatus,
  output: unknown,
  authority: ProducingAttempt,
): Promise<ApplicationExecutionResult | null> {
  if (status === "queued" || status === "in_progress") {
    return null;
  }
  if (status === "failed" || status === "cancelled" || status === "incomplete") {
    return dispatchIfCurrent(
      tools,
      failureEvent(pending.snapshot, {
        code: "RIM_AI_FAILED",
        message: status,
      } as unknown as Failure),
      authority,
    );
  }
  if (output === undefined) {
    return null;
  }
  return dispatchIfCurrent(tools, completionEvent(pending.snapshot, output), authority);
}

function producingAttempt(runtime: RimProviderRuntime): ProducingAttempt | null {
  const attempt = runtime.attempt;
  if (!attempt) {
    return null;
  }
  return {
    rimChatId: runtime.rimChatId,
    selectedContactId: runtime.selectedContactId,
    contextRequestId: runtime.contextRequestId,
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    continuityMode: runtime.continuityMode,
  };
}

/**
 * The producing attempt must still be current immediately before E-58 or E-59.
 * requestId is shared by a retired attempt and its replacement, so it is not enough.
 */
async function dispatchIfCurrent(
  tools: ReconcileTools,
  event: ProductEventInput,
  authority: ProducingAttempt,
): Promise<ApplicationExecutionResult | null> {
  const result = await commitProductEventIfAttemptCurrent(
    {
      context: tools.context,
      event,
      ...(tools.clientClaimedUserId === undefined
        ? {}
        : { clientClaimedUserId: tools.clientClaimedUserId }),
      authority,
    },
    tools.deps,
  );
  if (result === null) {
    emitDiagnostic({
      eventName: "rim.request.stale",
      source: "rim",
      meta: {
        classification: "STALE_AI_RESULT",
        requestId: authority.requestId,
        attemptId: authority.attemptId,
        actorId: tools.context.currentUserId,
      },
    });
    return null;
  }
  if (event.name === "RIM.AI_REQUEST_FAILED") {
    const failureCode =
      event.payload && typeof event.payload === "object" && "failure" in event.payload
        ? String((event.payload as { failure?: { code?: string } }).failure?.code ?? "")
        : "";
    const isTimeout = failureCode.toLowerCase().includes("timeout");
    emitDiagnostic({
      eventName: isTimeout ? "rim.request.timeout" : "rim.request.failed",
      source: "rim",
      meta: {
        classification: isTimeout ? "AI_TIMEOUT" : "INFRASTRUCTURE_FAILURE",
        requestId: authority.requestId,
        attemptId: authority.attemptId,
        actorId: tools.context.currentUserId,
        ...(failureCode.length > 0 ? { errorCode: failureCode.slice(0, 64) } : {}),
      },
    });
  } else if (event.name === "RIM.AI_RESULT_RECEIVED" && result.status === "APPLIED") {
    emitDiagnostic({
      eventName: "rim.request.completed",
      source: "rim",
      meta: {
        classification: "OK",
        requestId: authority.requestId,
        attemptId: authority.attemptId,
        actorId: tools.context.currentUserId,
      },
    });
  }
  return result;
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

function sameRetryIntent(
  left: RimRetryIntent | undefined,
  right: RimRetryIntent | undefined,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return (
    left.rimChatId === right.rimChatId &&
    left.contextRequestId === right.contextRequestId &&
    left.requestId === right.requestId &&
    left.attemptId === right.attemptId
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
    ...(runtime.retryIntent ? { retryIntent: runtime.retryIntent } : {}),
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
  const semantics = providerReadySemanticInputs();
  return {
    continuityMode: "local-canonical-history",
    requestId: pending.snapshot.requestId,
    rimChatId: pending.snapshot.rimChatId,
    contextRequestId: pending.snapshot.contextRequestId,
    relationshipContext,
    conversationalOrigin: pending.chat.askRimOrigin,
    rimPrompt: semantics.rimPrompt,
    productSemantics: semantics.productSemantics,
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
