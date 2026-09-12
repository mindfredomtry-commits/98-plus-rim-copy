export type PersistenceErrorCode =
  | "IDENTITY_REQUIRED"
  | "REVISION_CONFLICT"
  | "CHECK_PAIR_CONFLICT"
  | "APPLIED_TRANSITION_REQUIRED"
  | "INVARIANT"
  | "MISSING_FACT"
  | "TRANSACTION_FAILED";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}
