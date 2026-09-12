export type ApplicationErrorCode =
  | "INVALID_EVENT"
  | "REVISION_CONFLICT"
  | "PERSISTENCE_INVARIANT"
  | "PERSISTENCE_FAILURE"
  | "KERNEL_INVARIANT"
  | "INFRASTRUCTURE_FAILURE";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly causeError: unknown;

  constructor(code: ApplicationErrorCode, message: string, causeError?: unknown) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.causeError = causeError;
  }
}
