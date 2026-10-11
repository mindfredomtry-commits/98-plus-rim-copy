import { describe, expect, it } from "vitest";
import { assertSafeMvp17TestDatabaseUrl } from "./test-database-guard.ts";

const VALID =
  "postgresql://mvp17_test:secret@127.0.0.1:55432/mvp17_12d1c_test";

describe("MVP17 PostgreSQL test database guard (G1–G8)", () => {
  it("G1. Valid local disposable test URL accepted", () => {
    const safe = assertSafeMvp17TestDatabaseUrl(VALID, {});
    expect(safe.host).toBe("127.0.0.1");
    expect(safe.port).toBe(55432);
    expect(safe.database).toBe("mvp17_12d1c_test");
    expect(safe.user).toBe("mvp17_test");
  });

  it("G2. Railway URL rejected", () => {
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@containers-us-west-1.railway.app:5432/mvp17_12d1c_test",
        {},
      ),
    ).toThrow(/railway|production-like|loopback/i);
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@maglev.proxy.rlwy.net:1234/mvp17_12d1c_test",
        {},
      ),
    ).toThrow(/railway|production-like|loopback|rlwy/i);
  });

  it("G3. Remote hostname rejected", () => {
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@db.example.com:5432/mvp17_12d1c_test",
        {},
      ),
    ).toThrow(/loopback/i);
  });

  it("G4. Non-test database name rejected", () => {
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@127.0.0.1:55432/production",
        {},
      ),
    ).toThrow(/database name/i);
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@127.0.0.1:55432/railway",
        {},
      ),
    ).toThrow(/database name/i);
  });

  it("G5. Missing URL fails safely without falling back", () => {
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(undefined, {
        DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mvp17_12d1c_test",
      }),
    ).toThrow(/MVP17_TEST_DATABASE_URL is required/);
    expect(() => assertSafeMvp17TestDatabaseUrl("", {})).toThrow(
      /MVP17_TEST_DATABASE_URL is required/,
    );
  });

  it("G6. Application DATABASE_URL does not override the test URL", () => {
    const safe = assertSafeMvp17TestDatabaseUrl(VALID, {
      DATABASE_URL: "postgresql://prod:secret@db.railway.app:5432/railway",
    });
    expect(safe.connectionString).toBe(VALID);
    expect(safe.host).toBe("127.0.0.1");
    expect(safe.database).toBe("mvp17_12d1c_test");
  });

  it("G7. Invalid URL rejected before any schema work", () => {
    expect(() => assertSafeMvp17TestDatabaseUrl("not-a-url", {})).toThrow(/malformed/i);
    expect(() =>
      assertSafeMvp17TestDatabaseUrl("http://127.0.0.1:55432/mvp17_12d1c_test", {}),
    ).toThrow(/protocol/i);
  });

  it("G8. Encoded or alternate host representations cannot bypass loopback", () => {
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@%65%78%61%6d%70%6c%65%2e%63%6f%6d:5432/mvp17_12d1c_test",
        {},
      ),
    ).toThrow(/loopback/i);
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@127.0.0.1:55432/mvp17_12d1c_test?host=db.example.com",
        {},
      ),
    ).toThrow(/loopback/i);
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@127.0.0.1:55432/mvp17_12d1c_test?hostaddr=8.8.8.8",
        {},
      ),
    ).toThrow(/loopback/i);
    expect(() =>
      assertSafeMvp17TestDatabaseUrl(
        "postgresql://u:p@127.0.0.1:55432/mvp17_12d1c_test?host=/var/run/postgresql",
        {},
      ),
    ).toThrow(/socket|filesystem|override/i);
    // Encoded loopback still accepted
    const encodedLoopback = assertSafeMvp17TestDatabaseUrl(
      "postgresql://u:p@%31%32%37%2e%30%2e%30%2e%31:55432/mvp17_12d1c_test",
      {},
    );
    expect(encodedLoopback.host).toBe("127.0.0.1");
  });
});
