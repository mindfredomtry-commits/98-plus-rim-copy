import type { InMemoryProductStore, PostgresProductStore, ProductStore } from "@98plus/persistence";

type Assert<T extends true> = T;
type PersistencePublic = typeof import("@98plus/persistence");

export type PersistenceTestKitIsNotAPublicExport = Assert<
  "PersistenceTestKit" extends keyof PersistencePublic ? false : true
>;

export type PublicApiHasNoSnapshotSeedSymbol = Assert<
  "seedSnapshot" extends keyof PersistencePublic
    ? false
    : "installFixture" extends keyof PersistencePublic
      ? false
      : "installFixtureSnapshot" extends keyof PersistencePublic
        ? false
        : "commitFixture" extends keyof PersistencePublic
          ? false
          : true
>;

export type ProductStoreHasNoSeedSnapshot = Assert<
  "seedSnapshot" extends keyof ProductStore ? false : true
>;

export type ProductStoreHasNoIdentityRegistration = Assert<
  "registerIdentityUser" extends keyof ProductStore
    ? false
    : "ensureIdentityUser" extends keyof ProductStore
      ? false
      : "upsertIdentityUser" extends keyof ProductStore
        ? false
        : "bootstrapIdentity" extends keyof ProductStore
          ? false
          : "syncIdentity" extends keyof ProductStore
            ? false
            : "registerCurrentUser" extends keyof ProductStore
              ? false
              : true
>;

export type PostgresProductStoreHasNoIdentityRegistration = Assert<
  "registerIdentityUser" extends keyof PostgresProductStore ? false : true
>;

export type InMemoryProductStoreHasNoIdentityRegistration = Assert<
  "registerIdentityUser" extends keyof InMemoryProductStore ? false : true
>;

export type ProductStoreHasNoInstallFixture = Assert<
  "installFixture" extends keyof ProductStore
    ? false
    : "installFixtureSnapshot" extends keyof ProductStore
      ? false
      : "commitFixture" extends keyof ProductStore
        ? false
        : true
>;

export type PostgresProductStoreHasNoSnapshotSeed = Assert<
  "seedSnapshot" extends keyof PostgresProductStore
    ? false
    : "installFixture" extends keyof PostgresProductStore
      ? false
      : "installFixtureSnapshot" extends keyof PostgresProductStore
        ? false
        : "commitFixture" extends keyof PostgresProductStore
          ? false
          : true
>;

export type InMemoryProductStoreHasNoSnapshotSeed = Assert<
  "seedSnapshot" extends keyof InMemoryProductStore
    ? false
    : "installFixture" extends keyof InMemoryProductStore
      ? false
      : "installFixtureSnapshot" extends keyof InMemoryProductStore
        ? false
        : "commitFixture" extends keyof InMemoryProductStore
          ? false
          : true
>;
