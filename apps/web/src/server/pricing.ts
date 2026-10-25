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

const UNIT = BigInt(10_000_000);

/** "47.22" -> 472200000 base units. Rejects more than 7 decimals or junk. */
export function toUnits(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal.trim());
  if (!m) throw new Error(`not a decimal amount: ${decimal}`);
  return BigInt(m[1]) * UNIT + BigInt((m[2] ?? "").padEnd(7, "0"));
}

/** units × rate (a decimal string), rounded up so Estela never undercharges. */
export function convert(units: bigint, rate: string): bigint {
  const r = toUnits(rate);
  return (units * r + UNIT - BigInt(1)) / UNIT;
}

export type PackagePrice = {
  /** Charged into the escrow, in the settlement token's base units. */
  amount: bigint;
  /** Organizer's ticket share (0 without a partner ticket). */
  payeeAmount: bigint;
  /** Estela's margin left after the discount: fee + ticket commission − discount. */
  margin: bigint;
  discount: bigint;
  /** What Duffel will charge, in the offer's currency (fiat base units). */
  flightCost: bigint;
};

/**
 * A flight (plus, optionally, a partner event ticket) with Estela's service fee.
 * Flight and fee are in the offer's fiat currency and converted with `rate` (1 for
 * EURC/USDC); the ticket is already priced in the settlement token. The member
 * discount only eats into Estela's margin (fee + ticket commission).
 */
export function pricePackage(opts: {
  flightTotal: string;
  serviceFee: string;
  passengers: number;
  /** Price in the settlement token's base units. */
  ticket?: { price: bigint; commissionBps: number };
  discountBps: number;
  rate: string;
}): PackagePrice {
  const flightCost = toUnits(opts.flightTotal);
  const flight = convert(flightCost, opts.rate);
  const fee = convert(toUnits(opts.serviceFee) * BigInt(opts.passengers), opts.rate);
  const ticketPrice = opts.ticket?.price ?? BigInt(0);
  const commission = opts.ticket ? (ticketPrice * BigInt(opts.ticket.commissionBps)) / BPS : BigInt(0);

  const gross = flight + fee + ticketPrice;
  const fullMargin = fee + commission;
  const wanted = (gross * BigInt(opts.discountBps)) / BPS;
  const discount = wanted < fullMargin ? wanted : fullMargin;

  return {
    amount: gross - discount,
    payeeAmount: opts.ticket ? ticketPrice - commission : BigInt(0),
    margin: fullMargin - discount,
    discount,
    flightCost,
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
