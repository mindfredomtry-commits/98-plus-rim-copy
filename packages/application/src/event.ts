import {
  isAbsentEventId,
  isCanonicalEventName,
  type CanonicalEvent,
  type CanonicalEventName,
} from "@98plus/product-model";
import { ApplicationError } from "./errors.ts";

export type ProductEventInput = CanonicalEvent | Readonly<{ name: unknown; payload?: unknown }>;

export function toCanonicalEvent(input: unknown): CanonicalEvent {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ApplicationError("INVALID_EVENT", "Product Event input must be an object");
  }
  const record = input as { name?: unknown; payload?: unknown };
  if (typeof record.name !== "string") {
    throw new ApplicationError("INVALID_EVENT", "Product Event name is required");
  }
  if (isAbsentEventId(record.name)) {
    throw new ApplicationError(
      "INVALID_EVENT",
      `${record.name} is intentionally absent and is not a Product Event name`,
    );
  }
  if (!isCanonicalEventName(record.name)) {
    throw new ApplicationError("INVALID_EVENT", `${record.name} is not a canonical Product Event`);
  }
  if (
    record.payload !== undefined &&
    (record.payload === null || typeof record.payload !== "object")
  ) {
    throw new ApplicationError(
      "INVALID_EVENT",
      "Product Event payload must be an object when present",
    );
  }
  return {
    name: record.name as CanonicalEventName,
    payload: (record.payload ?? {}) as CanonicalEvent["payload"],
  } as CanonicalEvent;
}
