import type {
  AiRequestId,
  Brand,
  ContextRequestId,
  RimChatId,
  UserId,
} from "@98plus/product-model";

/**
 * Application technical attempt identity.
 * Distinct from Product AiRequestId. Not a Product event id.
 */
export type RimProviderAttemptId = Brand<string, "RimProviderAttemptId">;

/** Provider conversation id. Present only after a create response was stored. */
export type ProviderConversationId = Brand<string, "ProviderConversationId">;

/** Provider response id. Present only after the application received it. */
export type ProviderResponseId = Brand<string, "ProviderResponseId">;

/**
 * Documented Response status values. Stored only after a known response was retrieved.
 * This does not authorize a retry.
 */
export type RetrievedProviderStatus =
  "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";

export type RimProviderInitialization =
  | {
      readonly submissionState: "not-submitted";
      readonly attemptId: RimProviderAttemptId;
      readonly clientRequestId: string | null;
    }
  | {
      readonly submissionState: "acceptance-unknown";
      readonly attemptId: RimProviderAttemptId;
      readonly clientRequestId: string | null;
    }
  | {
      readonly submissionState: "stored";
      readonly attemptId: RimProviderAttemptId;
      readonly conversationId: ProviderConversationId;
      readonly clientRequestId: string | null;
    };

/**
 * Technical provider attempt for the current logical Product request.
 * `acceptance-unknown` records that acceptance was not observed.
 * It is not a claim that the attempt may be replayed.
 */
export type RimProviderAttempt =
  | {
      readonly requestId: AiRequestId;
      readonly attemptId: RimProviderAttemptId;
      readonly submissionState: "not-submitted";
      readonly clientRequestId: string | null;
    }
  | {
      readonly requestId: AiRequestId;
      readonly attemptId: RimProviderAttemptId;
      readonly submissionState: "acceptance-unknown";
      readonly clientRequestId: string | null;
    }
  | {
      readonly requestId: AiRequestId;
      readonly attemptId: RimProviderAttemptId;
      readonly submissionState: "response-id-known";
      readonly responseId: ProviderResponseId;
      readonly clientRequestId: string | null;
    }
  | {
      readonly requestId: AiRequestId;
      readonly attemptId: RimProviderAttemptId;
      readonly submissionState: "completed-retrieved";
      readonly responseId: ProviderResponseId;
      readonly providerStatus: RetrievedProviderStatus;
      readonly clientRequestId: string | null;
    };

/**
 * Application runtime for one RimChatId.
 * Not part of Product RimChat, ProductSnapshot, or the Product Engine.
 */
export type RimProviderRuntime = Readonly<{
  rimChatId: RimChatId;
  selectedContactId: UserId;
  contextRequestId: ContextRequestId;
  initialization: RimProviderInitialization;
  attempt: RimProviderAttempt | null;
}>;

export type RimProviderRuntimeRejection = "not-an-object" | "shape" | "initialization" | "attempt";

export type RimProviderRuntimeParse =
  | { readonly status: "ABSENT" }
  | { readonly status: "INVALID"; readonly reason: RimProviderRuntimeRejection }
  | { readonly status: "PRESENT"; readonly runtime: RimProviderRuntime };

const PROVIDER_STATUSES = [
  "completed",
  "failed",
  "in_progress",
  "cancelled",
  "queued",
  "incomplete",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function clientRequestId(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (nonEmptyString(value)) {
    return value;
  }
  return undefined;
}

function parseInitialization(value: unknown): RimProviderInitialization | null {
  if (!isRecord(value)) {
    return null;
  }
  const diagnostic = clientRequestId(value.clientRequestId);
  if (diagnostic === undefined || !nonEmptyString(value.attemptId)) {
    return null;
  }
  const attemptId = value.attemptId as RimProviderAttemptId;
  if (value.submissionState === "not-submitted" || value.submissionState === "acceptance-unknown") {
    if (!hasOnlyKeys(value, ["submissionState", "attemptId", "clientRequestId"])) {
      return null;
    }
    return {
      submissionState: value.submissionState,
      attemptId,
      clientRequestId: diagnostic,
    };
  }
  if (value.submissionState === "stored") {
    if (
      !hasOnlyKeys(value, ["submissionState", "attemptId", "conversationId", "clientRequestId"]) ||
      !nonEmptyString(value.conversationId)
    ) {
      return null;
    }
    return {
      submissionState: "stored",
      attemptId,
      conversationId: value.conversationId as ProviderConversationId,
      clientRequestId: diagnostic,
    };
  }
  return null;
}

function parseAttempt(value: unknown): RimProviderAttempt | null {
  if (!isRecord(value)) {
    return null;
  }
  const diagnostic = clientRequestId(value.clientRequestId);
  if (
    diagnostic === undefined ||
    !nonEmptyString(value.requestId) ||
    !nonEmptyString(value.attemptId)
  ) {
    return null;
  }
  const requestId = value.requestId as AiRequestId;
  const attemptId = value.attemptId as RimProviderAttemptId;
  if (value.submissionState === "not-submitted" || value.submissionState === "acceptance-unknown") {
    if (!hasOnlyKeys(value, ["requestId", "attemptId", "submissionState", "clientRequestId"])) {
      return null;
    }
    return {
      requestId,
      attemptId,
      submissionState: value.submissionState,
      clientRequestId: diagnostic,
    };
  }
  if (value.submissionState === "response-id-known") {
    if (
      !hasOnlyKeys(value, [
        "requestId",
        "attemptId",
        "submissionState",
        "responseId",
        "clientRequestId",
      ]) ||
      !nonEmptyString(value.responseId)
    ) {
      return null;
    }
    return {
      requestId,
      attemptId,
      submissionState: "response-id-known",
      responseId: value.responseId as ProviderResponseId,
      clientRequestId: diagnostic,
    };
  }
  if (value.submissionState === "completed-retrieved") {
    if (
      !hasOnlyKeys(value, [
        "requestId",
        "attemptId",
        "submissionState",
        "responseId",
        "providerStatus",
        "clientRequestId",
      ]) ||
      !nonEmptyString(value.responseId) ||
      !PROVIDER_STATUSES.includes(value.providerStatus as RetrievedProviderStatus)
    ) {
      return null;
    }
    return {
      requestId,
      attemptId,
      submissionState: "completed-retrieved",
      responseId: value.responseId as ProviderResponseId,
      providerStatus: value.providerStatus as RetrievedProviderStatus,
      clientRequestId: diagnostic,
    };
  }
  return null;
}

export function parseRimProviderRuntime(value: unknown): RimProviderRuntimeParse {
  if (value === null || value === undefined) {
    return { status: "ABSENT" };
  }
  if (!isRecord(value)) {
    return { status: "INVALID", reason: "not-an-object" };
  }
  if (
    !hasOnlyKeys(value, [
      "rimChatId",
      "selectedContactId",
      "contextRequestId",
      "initialization",
      "attempt",
    ]) ||
    !nonEmptyString(value.rimChatId) ||
    !nonEmptyString(value.selectedContactId) ||
    !nonEmptyString(value.contextRequestId)
  ) {
    return { status: "INVALID", reason: "shape" };
  }
  const initialization = parseInitialization(value.initialization);
  if (!initialization) {
    return { status: "INVALID", reason: "initialization" };
  }
  if (value.attempt !== null) {
    const attempt = parseAttempt(value.attempt);
    if (!attempt) {
      return { status: "INVALID", reason: "attempt" };
    }
    return {
      status: "PRESENT",
      runtime: {
        rimChatId: value.rimChatId as RimChatId,
        selectedContactId: value.selectedContactId as UserId,
        contextRequestId: value.contextRequestId as ContextRequestId,
        initialization,
        attempt,
      },
    };
  }
  return {
    status: "PRESENT",
    runtime: {
      rimChatId: value.rimChatId as RimChatId,
      selectedContactId: value.selectedContactId as UserId,
      contextRequestId: value.contextRequestId as ContextRequestId,
      initialization,
      attempt: null,
    },
  };
}

/**
 * A stored runtime applies only to the exact RimChatId it names.
 * Same user, same contact, or a surviving provider conversation is not enough.
 * A terminated chat has no current RimChatId, so applicability fails while the record may remain.
 */
export function applicableRimProviderRuntime(
  parsed: RimProviderRuntimeParse,
  rimChatId: RimChatId | null,
): RimProviderRuntime | null {
  if (parsed.status !== "PRESENT" || rimChatId === null) {
    return null;
  }
  if (parsed.runtime.rimChatId !== rimChatId) {
    return null;
  }
  return parsed.runtime;
}
