import { afterEach, describe, expect, it, vi } from "vitest";
import { readSession, SESSION_TTL_SECONDS, signSession, type Session } from "./session";

const secret = "x".repeat(32);
const session: Session = { userId: "6f1c2c3e-0000-4000-8000-000000000001", wallet: "GABC", role: "traveler" };

afterEach(() => {
  vi.useRealTimers();
});

describe("session cookie", () => {
  it("round-trips the session", async () => {
    const token = await signSession(secret, session);
    expect(await readSession(secret, token)).toEqual(session);
  });

  it("returns null without a token", async () => {
    expect(await readSession(secret, undefined)).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signSession("y".repeat(32), session);
    expect(await readSession(secret, token)).toBeNull();
  });

  it("rejects a token whose role was edited", async () => {
    const token = await signSession(secret, session);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: session.userId, wallet: session.wallet, role: "admin" }),
    ).toString("base64url");
    expect(await readSession(secret, `${header}.${forged}.${signature}`)).toBeNull();
  });

  it("expires after the session TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const token = await signSession(secret, session);
    vi.setSystemTime(new Date(Date.now() + (SESSION_TTL_SECONDS + 60) * 1000));
    expect(await readSession(secret, token)).toBeNull();
  });
});
