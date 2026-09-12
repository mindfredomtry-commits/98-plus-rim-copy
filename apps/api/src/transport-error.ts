export type CreateBanContactTransportCode = "INVALID_CONTACT" | "SERVER_RESULT_NOT_ACCEPTED";

export type InvalidContactReason = "INVALID_SHAPE" | "UNREGISTERED" | "SELF" | "NOT_SELECTABLE";

export class CreateBanContactTransportError extends Error {
  readonly code: CreateBanContactTransportCode;
  readonly reason: string;

  constructor(code: CreateBanContactTransportCode, reason: string, message: string) {
    super(message);
    this.name = "CreateBanContactTransportError";
    this.code = code;
    this.reason = reason;
  }
}
