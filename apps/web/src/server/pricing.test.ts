import { describe, expect, it } from "vitest";
import { formatAmount, priceTicket, ticketDeadlines } from "./pricing";

const UNIT = BigInt(10_000_000);

describe("priceTicket", () => {
  it("splits the price between organizer and Estela without a discount", () => {
    // 150 USDC ticket, 8 % commission (the PLAN.md example).
    const p = priceTicket(BigInt(150) * UNIT, 800, 0);
    expect(p.amount).toBe(BigInt(150) * UNIT);
    expect(p.payeeAmount).toBe(BigInt(138) * UNIT);
    expect(p.commission).toBe(BigInt(12) * UNIT);
    expect(p.discount).toBe(BigInt(0));
  });

  it("takes the member discount from Estela's commission only", () => {
    // Voyager, 5 %: 7.5 off a 150 ticket; the organizer still gets 138.
    const p = priceTicket(BigInt(150) * UNIT, 800, 500);
    expect(p.discount).toBe(BigInt(75) * UNIT / BigInt(10));
    expect(p.amount).toBe(BigInt(1425) * UNIT / BigInt(10));
    expect(p.payeeAmount).toBe(BigInt(138) * UNIT);
    expect(p.commission).toBe(BigInt(45) * UNIT / BigInt(10));
  });

  it("caps the discount at the commission", () => {
    // Legend, 15 %, but Estela only takes 8 %: the discount stops at 8 %.
    const p = priceTicket(BigInt(100) * UNIT, 800, 1500);
    expect(p.discount).toBe(BigInt(8) * UNIT);
    expect(p.commission).toBe(BigInt(0));
    expect(p.payeeAmount).toBe(BigInt(92) * UNIT);
    expect(p.amount).toBe(p.payeeAmount);
  });

  it("always charges exactly organizer share + Estela commission", () => {
    for (const [price, c, d] of [[7, 800, 500], [999_999, 333, 1500], [1, 800, 1000]] as const) {
      const p = priceTicket(BigInt(price), c, d);
      expect(p.amount).toBe(p.payeeAmount + p.commission);
      expect(p.payeeAmount).toBeGreaterThanOrEqual(BigInt(0));
    }
  });

  it("rejects non-positive prices", () => {
    expect(() => priceTicket(BigInt(0), 800, 0)).toThrow();
  });
});

describe("ticketDeadlines", () => {
  const now = new Date("2026-10-25T12:00:00Z");

  it("gives 15 minutes to pay, an hour more to confirm, and free cancellation until 48 h before", () => {
    const d = ticketDeadlines(now, new Date("2026-11-25T18:00:00Z"));
    expect(d.payBefore.toISOString()).toBe("2026-10-25T12:15:00.000Z");
    expect(d.confirmBy.toISOString()).toBe("2026-10-25T13:15:00.000Z");
    expect(d.refundUntil.toISOString()).toBe("2026-11-23T18:00:00.000Z");
  });

  it("offers no free cancellation when the event is too close", () => {
    const d = ticketDeadlines(now, new Date("2026-10-26T12:00:00Z"));
    expect(d.refundUntil).toEqual(now);
  });
});

describe("formatAmount", () => {
  it("formats base units with 7 decimals", () => {
    expect(formatAmount(BigInt(50_000_000))).toBe("5");
    expect(formatAmount(BigInt(123_456_789))).toBe("12.3456789");
    expect(formatAmount(BigInt(1))).toBe("0.0000001");
  });
});
