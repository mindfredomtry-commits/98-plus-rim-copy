import type { UserId } from "@98plus/product-model";
import type { RegisteredUserDirectory } from "./directory.ts";
import { CreateBanContactTransportError, type InvalidContactReason } from "./transport-error.ts";

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

export function readSelectContactId(payload: unknown): string | null {
  const record = payloadRecord(payload);
  if (!record) {
    return null;
  }
  const contactId = record.contactId;
  if (typeof contactId !== "string") {
    return null;
  }
  const trimmed = contactId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function assertSelectableContactId(
  directory: RegisteredUserDirectory,
  currentUserId: UserId,
  payload: unknown,
  eventLabel: string = "SELECT_CONTACT",
): Promise<UserId> {
  const contactId = readSelectContactId(payload);
  if (contactId === null) {
    throw invalid("INVALID_SHAPE", `${eventLabel} requires contactId as a non-empty string`);
  }
  if (contactId === currentUserId) {
    throw invalid("SELF", `${eventLabel} cannot select the authenticated current user`);
  }
  if (!(await directory.isRegisteredUserId(contactId))) {
    throw invalid(
      "UNREGISTERED",
      `${eventLabel} contactId must be an already-registered internal UserId`,
    );
  }
  const selectable = await directory.listSelectableContacts(currentUserId);
  if (!selectable.some((user) => user.userId === contactId)) {
    throw invalid(
      "NOT_SELECTABLE",
      `${eventLabel} contactId is not in the current user's MVP8 Contact set`,
    );
  }
  return contactId as UserId;
}

function invalid(reason: InvalidContactReason, message: string): CreateBanContactTransportError {
  return new CreateBanContactTransportError("INVALID_CONTACT", reason, message);
}
