declare const opaque: unique symbol;

export type Opaque<Name extends string> = { readonly [opaque]: Name };

export type Instant = Opaque<"Instant">;
export type Failure = Opaque<"Failure">;
export type ShareResult = Opaque<"ShareResult">;
export type ShareToken = Opaque<"ShareToken">;
export type ServerState = Opaque<"ServerState">;
export type TemplateContext = Opaque<"TemplateContext">;
export type ShareLinkFailureReason = Opaque<"ShareLinkFailureReason">;

export type Role = "RECEIVER" | "SENDER";
export type CheckAnswer = "FULFILLED" | "NOT_FULFILLED";
export type BanStatus = "OVERBOARD" | "BANTASTIC" | "BANFLICT" | "FAIR_ENOUGH";
export type CheckDerivedStatus = Exclude<BanStatus, "OVERBOARD">;
export type ConnectionState = "ONLINE" | "OFFLINE";
export type SessionStatus = "ACTIVE" | "CLOSED";
export type DurationInput = number;

export const MIN_DURATION_MINUTES = 3;
export const MAX_DURATION_MINUTES = 60;
export const PENDING_EXTERNAL_ENTRY_TTL_MS = 60_000;
export const RELATIONSHIP_BAN_LIMIT = 10;
export const RIM_SUGGESTION_COUNT = 3;

export function isValidDurationMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_DURATION_MINUTES && value <= MAX_DURATION_MINUTES;
}

export function isValidBanText(value: string): boolean {
  return value.trim().length >= 1;
}

export function isValidPercentage(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}
