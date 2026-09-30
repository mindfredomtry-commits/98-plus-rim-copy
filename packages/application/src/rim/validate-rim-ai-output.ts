import {
  isValidBanText,
  isValidExecutionProbability,
  RIM_SUGGESTION_COUNT,
  type ExecutionProbability,
  type RimAiResult,
  type RimSuggestion,
} from "@98plus/product-model";

/**
 * Structural gate for untrusted provider output.
 * Accepts the contract `type` field and the existing Application `kind` field
 * as the same transport representation. Does not repair semantic content.
 */
export type RimAiOutputRejection =
  | "not-an-object"
  | "response-type"
  | "message-text"
  | "message-shape"
  | "ban-message"
  | "ban-shape"
  | "proposal-count"
  | "proposal-shape"
  | "proposal-ban-text"
  | "proposal-probability";

export type RimAiOutputValidation =
  | { readonly ok: true; readonly result: RimAiResult }
  | { readonly ok: false; readonly reason: RimAiOutputRejection };

const RESPONSE_TYPES = ["MESSAGE", "BAN_PROPOSALS"] as const;
type ResponseType = (typeof RESPONSE_TYPES)[number];

export const RIM_AI_OUTPUT_INVALID = "RIM_AI_OUTPUT_INVALID";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isResponseType(value: unknown): value is ResponseType {
  return typeof value === "string" && (RESPONSE_TYPES as readonly string[]).includes(value);
}

function responseType(value: Record<string, unknown>): ResponseType | null {
  const typePresent = "type" in value;
  const kindPresent = "kind" in value;
  const type = value.type;
  const kind = value.kind;
  if (typePresent && kindPresent) {
    return isResponseType(type) && isResponseType(kind) && type === kind ? type : null;
  }
  if (typePresent) {
    return isResponseType(type) ? type : null;
  }
  if (kindPresent) {
    return isResponseType(kind) ? kind : null;
  }
  return null;
}

/** Emptiness uses trim. The accepted provider string is stored unchanged. */
function conversationalText(value: unknown): string | null {
  if (typeof value !== "string" || !isValidBanText(value)) {
    return null;
  }
  return value;
}

function proposalOf(value: unknown): RimSuggestion | RimAiOutputRejection {
  if (!isRecord(value) || !hasOnlyKeys(value, ["banText", "executionProbability", "proposalId"])) {
    return "proposal-shape";
  }
  if (typeof value.banText !== "string" || !isValidBanText(value.banText)) {
    return "proposal-ban-text";
  }
  if (
    typeof value.executionProbability !== "number" ||
    !isValidExecutionProbability(value.executionProbability)
  ) {
    return "proposal-probability";
  }
  return {
    banText: value.banText,
    executionProbability: value.executionProbability as ExecutionProbability,
  };
}

function banProposals(value: Record<string, unknown>): RimAiOutputValidation {
  if (!hasOnlyKeys(value, ["type", "kind", "message", "proposals"])) {
    return { ok: false, reason: "ban-shape" };
  }
  const message = conversationalText(value.message);
  if (!message) {
    return { ok: false, reason: "ban-message" };
  }
  if (!Array.isArray(value.proposals) || value.proposals.length !== RIM_SUGGESTION_COUNT) {
    return { ok: false, reason: "proposal-count" };
  }
  const proposals: RimSuggestion[] = [];
  for (const item of value.proposals) {
    const proposal = proposalOf(item);
    if (typeof proposal === "string") {
      return { ok: false, reason: proposal };
    }
    proposals.push(proposal);
  }
  const [first, second, third] = proposals;
  if (!first || !second || !third) {
    return { ok: false, reason: "proposal-count" };
  }
  return {
    ok: true,
    result: {
      kind: "BAN_PROPOSALS",
      message,
      proposals: [first, second, third],
    },
  };
}

function messageResult(value: Record<string, unknown>): RimAiOutputValidation {
  if (!hasOnlyKeys(value, ["type", "kind", "text"])) {
    return { ok: false, reason: "message-shape" };
  }
  const text = conversationalText(value.text);
  if (!text) {
    return { ok: false, reason: "message-text" };
  }
  return { ok: true, result: { kind: "MESSAGE", text } };
}

export function validateRimAiOutput(output: unknown): RimAiOutputValidation {
  if (!isRecord(output)) {
    return { ok: false, reason: "not-an-object" };
  }
  const type = responseType(output);
  if (!type) {
    return { ok: false, reason: "response-type" };
  }
  return type === "MESSAGE" ? messageResult(output) : banProposals(output);
}
