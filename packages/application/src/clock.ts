import { randomUUID } from "node:crypto";

export type ApplicationClock = Readonly<{
  nowMs: () => number;
}>;

export type IdAllocator = (kind: string) => string;

export const systemClock: ApplicationClock = {
  nowMs: () => Date.now(),
};

export function randomIdAllocator(): IdAllocator {
  return (kind: string) => `${kind}-${randomUUID()}`;
}
