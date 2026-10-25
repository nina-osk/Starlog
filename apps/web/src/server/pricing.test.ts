import { describe, expect, it } from "vitest";
import { convert, formatAmount, pricePackage, priceTicket, ticketDeadlines, toUnits } from "./pricing";

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

describe("toUnits / convert", () => {
  it("parses decimal strings exactly", () => {
    expect(toUnits("47.22")).toBe(BigInt(472_200_000));
    expect(toUnits("10")).toBe(BigInt(100_000_000));
    expect(toUnits("0.0000001")).toBe(BigInt(1));
    expect(() => toUnits("1.12345678")).toThrow();
    expect(() => toUnits("-3")).toThrow();
  });

  it("converts with a rate, rounding up", () => {
    expect(convert(BigInt(100_000_000), "1")).toBe(BigInt(100_000_000));
    expect(convert(BigInt(100_000_000), "2.5")).toBe(BigInt(250_000_000));
    expect(convert(BigInt(1), "0.5")).toBe(BigInt(1));
  });
});

describe("pricePackage", () => {
  const event = { price: BigInt(150) * UNIT, commissionBps: 800 };

  it("adds flight, service fee and ticket; the organizer keeps its share", () => {
    const p = pricePackage({ flightTotal: "47.22", serviceFee: "10", passengers: 1, ticket: event, discountBps: 0, rate: "1" });
    expect(p.flightCost).toBe(toUnits("47.22"));
    expect(p.amount).toBe(toUnits("207.22")); // 47.22 + 10 + 150
    expect(p.payeeAmount).toBe(toUnits("138"));
    expect(p.margin).toBe(toUnits("22")); // fee 10 + commission 12
    expect(p.amount - p.payeeAmount - p.margin).toBe(p.flightCost); // the rest pays Duffel
  });

  it("takes the discount from Estela's margin only", () => {
    // Legend 15 % of 207.22 would be 31.08, more than the 22 margin: capped at 22.
    const p = pricePackage({ flightTotal: "47.22", serviceFee: "10", passengers: 1, ticket: event, discountBps: 1500, rate: "1" });
    expect(p.discount).toBe(toUnits("22"));
    expect(p.margin).toBe(BigInt(0));
    expect(p.amount).toBe(toUnits("185.22"));
    expect(p.payeeAmount).toBe(toUnits("138"));
  });

  it("works without a ticket and charges the fee per passenger", () => {
    const p = pricePackage({ flightTotal: "100", serviceFee: "10", passengers: 2, discountBps: 500, rate: "1" });
    expect(p.payeeAmount).toBe(BigInt(0));
    expect(p.discount).toBe(toUnits("6")); // 5 % of 120
    expect(p.amount).toBe(toUnits("114"));
  });

  it("converts flight and fee to the settlement token, not the ticket", () => {
    // 40 € flight + 10 € fee at 3 XLM/€, plus a 5 XLM ticket with 8 % commission.
    const p = pricePackage({
      flightTotal: "40",
      serviceFee: "10",
      passengers: 1,
      ticket: { price: BigInt(5) * UNIT, commissionBps: 800 },
      discountBps: 0,
      rate: "3",
    });
    expect(p.amount).toBe(toUnits("155"));
    expect(p.payeeAmount).toBe(toUnits("4.6"));
    expect(p.margin).toBe(toUnits("30.4"));
    expect(p.flightCost).toBe(toUnits("40")); // Duffel is still paid in fiat
  });
});

describe("formatAmount", () => {
  it("formats base units with 7 decimals", () => {
    expect(formatAmount(BigInt(50_000_000))).toBe("5");
    expect(formatAmount(BigInt(123_456_789))).toBe("12.3456789");
    expect(formatAmount(BigInt(1))).toBe("0.0000001");
  });
});
