import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptySnapshot, type TransitionResult, type UserId } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";
import { InMemoryProductStore } from "./in-memory-store.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const USER_ID = "user-ownership" as UserId;

function claim(attemptId: string) {
  return {
    currentUserId: USER_ID,
    operationKind: "initialization" as const,
    attemptId,
    requestId: null,
    leaseSeconds: 30,
    runtime: { marker: "acceptance-unknown", attemptId },
  };
}

async function opened() {
  const kit = PersistenceTestKit.inMemory();
  kit.establishIdentity(USER_ID, "tg-ownership");
  const seeded = await kit.installFixtureSnapshot(USER_ID, emptySnapshot());
  const store = kit.memoryStore;
  if (!store) {
    throw new Error("expected the in-memory store");
  }
  return { store, revision: seeded.revision };
}

describe("in-memory RIM provider ownership", () => {
  it("acquires once, rejects a second token, and keeps Product revision on heartbeat and release", async () => {
    const { store, revision } = await opened();
    const first = await store.acquireRimProviderOwnership({
      ...claim("attempt-1"),
      expectedRevision: revision,
    });
    expect(first.status).toBe("ACQUIRED");
    if (first.status !== "ACQUIRED") {
      return;
    }
    expect(first.loaded.revision).toBe(revision + 1);
    expect(first.loaded.rimProviderRuntime).toEqual(claim("attempt-1").runtime);
    expect(first.ownership.phase).toBe("held");

    const again = await store.acquireRimProviderOwnership({
      ...claim("attempt-1"),
      expectedRevision: first.loaded.revision,
    });
    expect(again.status).toBe("ALREADY_PRESENT");
    if (again.status !== "ALREADY_PRESENT") {
      return;
    }
    expect(again.ownership.ownerToken).toBe(first.ownership.ownerToken);
    expect(again.loaded.revision).toBe(first.loaded.revision);

    const renewed = await store.renewRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-1",
      ownerToken: first.ownership.ownerToken,
      leaseSeconds: 30,
    });
    expect(renewed.status).toBe("RENEWED");
    const mismatched = await store.renewRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-1",
      ownerToken: randomUUID(),
      leaseSeconds: 30,
    });
    expect(mismatched.status).toBe("REJECTED");
    if (mismatched.status === "REJECTED") {
      expect(mismatched.reason).toBe("TOKEN_MISMATCH");
      expect(mismatched.ownership?.ownerToken).toBe(first.ownership.ownerToken);
    }
    const wrongRelease = await store.releaseRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-1",
      ownerToken: randomUUID(),
      releaseReason: "completed",
    });
    expect(wrongRelease.status).toBe("REJECTED");
    const released = await store.releaseRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-1",
      ownerToken: first.ownership.ownerToken,
      releaseReason: "owner-terminated",
    });
    expect(released.status).toBe("RELEASED");
    if (released.status === "RELEASED") {
      expect(released.ownership.releaseReason).toBe("owner-terminated");
      expect(released.ownership.ownerToken).toBe(first.ownership.ownerToken);
      expect(released.ownership.phase).toBe("released");
    }
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(first.loaded.revision);
  });

  it("does not transfer a token after the lease deadline and does not bump revision", async () => {
    const { store, revision } = await opened();
    const first = await store.acquireRimProviderOwnership({
      ...claim("attempt-expired"),
      expectedRevision: revision,
    });
    if (first.status !== "ACQUIRED") {
      throw new Error("expected acquire");
    }
    store
      .inspect()
      .retimeOwnershipLease(USER_ID, "initialization", "attempt-expired", Date.now() - 1_000);
    const expired = await store.renewRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-expired",
      ownerToken: first.ownership.ownerToken,
      leaseSeconds: 30,
    });
    expect(expired.status).toBe("REJECTED");
    if (expired.status === "REJECTED") {
      expect(expired.reason).toBe("EXPIRED");
      expect(expired.ownership?.ownerToken).toBe(first.ownership.ownerToken);
      expect(expired.ownership?.phase).toBe("renewal-lapsed");
    }
    const stolen = await store.acquireRimProviderOwnership({
      ...claim("attempt-expired"),
      expectedRevision: first.loaded.revision,
    });
    expect(stolen.status).toBe("ALREADY_PRESENT");
    if (stolen.status === "ALREADY_PRESENT") {
      expect(stolen.ownership.ownerToken).toBe(first.ownership.ownerToken);
      expect(stolen.loaded.revision).toBe(first.loaded.revision);
    }
  });

  it("rolls back an acquire that fails after the ownership insert", async () => {
    const { store, revision } = await opened();
    store.failNextOwnershipAcquireAfterInsert();
    await expect(
      store.acquireRimProviderOwnership({
        ...claim("attempt-rollback"),
        expectedRevision: revision,
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    expect(
      await store.lookupRimProviderOwnership({
        currentUserId: USER_ID,
        operationKind: "initialization",
        attemptId: "attempt-rollback",
      }),
    ).toBeNull();
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(revision);
    expect(loaded.rimProviderRuntime).toBeNull();
  });

  it("lets one competing acquire win and preserves the row across a Product write", async () => {
    const { store, revision } = await opened();
    const raced = await Promise.allSettled([
      store.acquireRimProviderOwnership({ ...claim("attempt-race"), expectedRevision: revision }),
      store.acquireRimProviderOwnership({ ...claim("attempt-race"), expectedRevision: revision }),
    ]);
    const acquired = raced.find((result) => result.status === "fulfilled");
    const rejected = raced.find((result) => result.status === "rejected");
    expect(acquired?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(PersistenceError);
      expect((rejected.reason as PersistenceError).code).toBe("REVISION_CONFLICT");
    }
    if (acquired?.status !== "fulfilled" || acquired.value.status !== "ACQUIRED") {
      throw new Error("expected one acquire");
    }
    const token = acquired.value.ownership.ownerToken;
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: acquired.value.loaded.revision,
      result: { outcome: "APPLIED", snapshot: acquired.value.loaded.snapshot } as TransitionResult,
    });
    const kept = await store.lookupRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-race",
    });
    expect(kept?.ownerToken).toBe(token);
    expect(kept?.phase).toBe("held");
    const other = new InMemoryProductStore();
    expect(
      await other.lookupRimProviderOwnership({
        currentUserId: USER_ID,
        operationKind: "initialization",
        attemptId: "attempt-race",
      }),
    ).toBeNull();
  });

  it("invalidates under the session lock and rolls the mark back when the callback throws", async () => {
    const { store, revision } = await opened();
    const first = await store.acquireRimProviderOwnership({
      ...claim("attempt-fence"),
      expectedRevision: revision,
    });
    if (first.status !== "ACQUIRED") {
      throw new Error("expected acquire");
    }
    await expect(
      store.releaseRimProviderOwnership({
        currentUserId: USER_ID,
        operationKind: "initialization",
        attemptId: "attempt-fence",
        ownerToken: first.ownership.ownerToken,
        releaseReason: "chat-abandoned" as "completed",
      }),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    let firstEntered = false;
    let secondEntered = false;
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const held = store.withRimProviderOwnershipCoordination(
      { currentUserId: USER_ID, operationKind: "initialization", attemptId: "attempt-fence" },
      async (context) => {
        firstEntered = true;
        expect(context.revision).toBe(first.loaded.revision);
        expect(context.ownership?.ownerToken).toBe(first.ownership.ownerToken);
        await gate;
      },
    );
    for (let attempt = 0; attempt < 100 && !firstEntered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(firstEntered).toBe(true);
    const waiting = store.withRimProviderOwnershipCoordination(
      { currentUserId: USER_ID, operationKind: "initialization", attemptId: "attempt-fence" },
      async () => {
        secondEntered = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await held;
    await waiting;
    expect(secondEntered).toBe(true);

    await expect(
      store.withRimProviderOwnershipCoordination(
        { currentUserId: USER_ID, operationKind: "initialization", attemptId: "attempt-fence" },
        async (context) => {
          const marked = await context.invalidate("superseded");
          expect(marked.status).toBe("INVALIDATED");
          throw new Error("coordination failed");
        },
      ),
    ).rejects.toThrow("coordination failed");
    const kept = await store.lookupRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-fence",
    });
    expect(kept?.phase).toBe("held");
    expect(kept?.ownerToken).toBe(first.ownership.ownerToken);
    const invalidated = await store.invalidateRimProviderOwnership({
      currentUserId: USER_ID,
      operationKind: "initialization",
      attemptId: "attempt-fence",
      releaseReason: "chat-abandoned",
    });
    expect(invalidated.status).toBe("INVALIDATED");
    if (invalidated.status === "INVALIDATED") {
      expect(invalidated.ownership.ownerToken).toBe(first.ownership.ownerToken);
      expect(invalidated.ownership.releaseReason).toBe("chat-abandoned");
    }
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(first.loaded.revision);
  });
});
