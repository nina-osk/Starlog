// Prices and escrow deadlines for an Estela booking. Amounts are token base units
// (7 decimals) as bigint; basis points: 10_000 = 100 %.

const BPS = BigInt(10_000);

export type TicketPrice = {
  /** What the traveler pays into the escrow. */
  amount: bigint;
  /** The organizer's share, paid directly on release. */
  payeeAmount: bigint;
  /** Estela's commission after the member discount. */
  commission: bigint;
  /** What the member's level saved them. */
  discount: bigint;
};

/**
 * The member discount comes out of Estela's commission, never out of the organizer's
 * share: it is capped at the commission.
 */
export function priceTicket(ticketPrice: bigint, commissionBps: number, discountBps: number): TicketPrice {
  if (ticketPrice <= BigInt(0)) throw new Error("ticket price must be positive");
  const fullCommission = (ticketPrice * BigInt(commissionBps)) / BPS;
  const wanted = (ticketPrice * BigInt(discountBps)) / BPS;
  const discount = wanted < fullCommission ? wanted : fullCommission;
  return {
    amount: ticketPrice - discount,
    payeeAmount: ticketPrice - fullCommission,
    commission: fullCommission - discount,
    discount,
  };
}

export const PAY_WINDOW_MS = 15 * 60 * 1000;
// Tickets need no supplier booking, so Estela confirms right after payment; the
// traveler can reclaim if that hasn't happened an hour after the pay window.
export const TICKET_CONFIRM_MS = 60 * 60 * 1000;
export const DEFAULT_FULL_REFUND_HOURS = 48;

export function ticketDeadlines(now: Date, eventStartsAt: Date, fullRefundUntilHours = DEFAULT_FULL_REFUND_HOURS) {
  const payBefore = new Date(now.getTime() + PAY_WINDOW_MS);
  const lastFreeCancel = new Date(eventStartsAt.getTime() - fullRefundUntilHours * 3_600_000);
  return {
    payBefore,
    // Too close to the event: no free cancellation, only the organizer's policy.
    refundUntil: lastFreeCancel > now ? lastFreeCancel : now,
    confirmBy: new Date(payBefore.getTime() + TICKET_CONFIRM_MS),
  };
}

/** 123456789 base units -> "12.3456789" (trailing zeros trimmed). */
export function formatAmount(units: bigint): string {
  const negative = units < BigInt(0);
  const abs = negative ? -units : units;
  const whole = abs / BigInt(10_000_000);
  const frac = (abs % BigInt(10_000_000)).toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
