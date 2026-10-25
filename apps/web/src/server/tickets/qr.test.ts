import { describe, expect, it } from "vitest";
import { parseQr, QR_WINDOW_MS, qrPayload, verifyQr } from "./qr";

const ticket = "6f1c2c3e-0000-4000-8000-000000000001";
const secret = "s3cret-for-this-ticket-only";
const now = Date.UTC(2026, 10, 24, 20, 0, 30);

describe("check-in QR", () => {
  it("accepts a fresh code", () => {
    expect(verifyQr(qrPayload(ticket, secret, now), secret, now)).toBe(true);
  });

  it("accepts a code from the previous minute, for slow scans", () => {
    const code = qrPayload(ticket, secret, now);
    expect(verifyQr(code, secret, now + QR_WINDOW_MS)).toBe(true);
  });

  it("rejects a screenshot two minutes later", () => {
    const code = qrPayload(ticket, secret, now);
    expect(verifyQr(code, secret, now + 2 * QR_WINDOW_MS)).toBe(false);
  });

  it("rejects codes from the future", () => {
    const code = qrPayload(ticket, secret, now + QR_WINDOW_MS);
    expect(verifyQr(code, secret, now)).toBe(false);
  });

  it("rejects a code signed with another ticket's secret", () => {
    expect(verifyQr(qrPayload(ticket, "other-secret", now), secret, now)).toBe(false);
  });

  it("rejects a code moved to another ticket id", () => {
    const [, slot, mac] = qrPayload(ticket, secret, now).split(".");
    const other = "6f1c2c3e-0000-4000-8000-000000000002";
    expect(verifyQr(`${other}.${slot}.${mac}`, secret, now)).toBe(false);
  });

  it("rejects garbage", () => {
    for (const junk of ["", "hello", `${ticket}.x.y`, `${ticket}.1.short`, "a.b.c.d"]) {
      expect(verifyQr(junk, secret, now)).toBe(false);
    }
    expect(parseQr("not-a-code")).toBeNull();
  });
});
