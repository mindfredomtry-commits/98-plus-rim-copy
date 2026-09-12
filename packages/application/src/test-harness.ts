import { asTelegramUserId, type AuthenticatedContext } from "@98plus/identity";
import { InMemoryProductStore, type ProductStore } from "@98plus/persistence";
import {
  counterAllocator,
  type BanId,
  type CanonicalEvent,
  type OperationId,
  type UserId,
} from "@98plus/product-model";
import { executeProductEvent, type ProductExecutorDependencies } from "./execute.ts";

export const SENDER_ID = "user-from-auth" as UserId;
export const RECEIVER_ID = "contact-a" as UserId;

export function authContext(userId: UserId, telegramUserId: string): AuthenticatedContext {
  return {
    currentUserId: userId,
    currentTelegramUser: { telegramUserId: asTelegramUserId(telegramUserId) },
    authenticationMethod: "telegram",
  };
}

export function eventOf(name: CanonicalEvent["name"], payload: object = {}): CanonicalEvent {
  return { name, payload } as CanonicalEvent;
}

export function establishTestIdentity(
  store: InMemoryProductStore,
  userId: UserId,
  telegramUserId: string,
): void {
  store.inspect().registerIdentityUser(userId, telegramUserId);
}

export type Executor = (event: CanonicalEvent) => ReturnType<typeof executeProductEvent>;

export async function productApp(
  store: InMemoryProductStore = new InMemoryProductStore(),
): Promise<{
  store: ProductStore;
  sender: Executor;
  receiver: Executor;
  advance: (ms: number) => void;
}> {
  establishTestIdentity(store, SENDER_ID, "tg-sender");
  establishTestIdentity(store, RECEIVER_ID, "tg-receiver");
  let now = 1_000_000;
  const clock = { nowMs: () => now };
  const senderDeps: ProductExecutorDependencies = {
    store,
    clock,
    allocateId: counterAllocator(1),
  };
  const receiverDeps: ProductExecutorDependencies = {
    store,
    clock,
    allocateId: counterAllocator(100),
  };
  const senderContext = authContext(SENDER_ID, "tg-sender");
  const receiverContext = authContext(RECEIVER_ID, "tg-receiver");
  const sender: Executor = (event) =>
    executeProductEvent({ context: senderContext, event }, senderDeps);
  const receiver: Executor = (event) =>
    executeProductEvent({ context: receiverContext, event }, receiverDeps);
  return {
    store,
    sender,
    receiver,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export async function openLobby(exec: Executor) {
  const opened = await exec(eventOf("APP.NORMAL_OPEN", { serverState: {} }));
  if (opened.status !== "APPLIED" && opened.snapshot.controlState !== "RIM.LOBBY") {
    throw new Error(`expected RIM.LOBBY, got ${opened.status} ${opened.snapshot.controlState}`);
  }
  return opened;
}

export async function createContactBan(sender: Executor, receiverId: UserId = RECEIVER_ID) {
  await openLobby(sender);
  const start = await sender(eventOf("CREATE_BAN.PRESS_START"));
  if (start.status !== "APPLIED") {
    throw new Error(`PRESS_START ${start.status} ${start.kernelError?.message ?? ""}`);
  }
  await sender(eventOf("CREATE_BAN.SELECT_CONTACT", { contactId: receiverId }));
  await sender(eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "no phones" }));
  await sender(eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 }));
  await sender(eventOf("CREATE_BAN.PRESS_NEXT"));
  const pending = await sender(eventOf("CREATE_BAN.PRESS_FORBID"));
  const operationId = Object.keys(pending.snapshot.runtime.pendingOperations)[0] as OperationId;
  const createdBanId = "ban-contact-1" as BanId;
  const confirmed = await sender(
    eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId, createdBanId }),
  );
  return { confirmed, createdBanId, operationId };
}
