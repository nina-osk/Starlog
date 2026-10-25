import {
  bigint,
  bigserial,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Every table enables RLS without policies: Supabase's public (anon) API can't touch
// them, and only the server, connecting straight to Postgres, reads and writes.

// Token amounts are in base units (7 decimals) and can exceed JS numbers, so they
// are stored as numeric and handled as strings/BigInt.
const amount = (name: string) => numeric(name, { precision: 39, scale: 0 });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const userRole = pgEnum("user_role", ["traveler", "organizer", "staff", "admin"]);
// XLM is accepted by the testnet escrow too, for demos with freshly created wallets.
export const currency = pgEnum("currency", ["USDC", "EURC", "XLM"]);
export const eventSource = pgEnum("event_source", ["partner", "luma"]);
export const eventStatus = pgEnum("event_status", ["draft", "published", "cancelled"]);
export const bookingKind = pgEnum("booking_kind", ["ticket", "package", "travel"]);
export const bookingStatus = pgEnum("booking_status", [
  "escrow_created",
  "funded",
  "supplier_booking",
  "confirmed",
  "failed",
  "cancel_requested",
  "refunded",
  "expired",
]);
export const stampKind = pgEnum("stamp_kind", ["event", "trip"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stellar address (G... from Pollar), the identity proven by SEP-10.
  wallet: text("wallet").notNull().unique(),
  email: text("email"),
  role: userRole("role").notNull().default("traveler"),
  createdAt: createdAt(),
}).enableRLS();

export const organizers = pgTable("organizers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => users.id),
  name: text("name").notNull(),
  // Receives payee_amount on release.
  payoutWallet: text("payout_wallet").notNull(),
  // Estela's commission on this organizer's tickets (800 = 8 %).
  commissionBps: integer("commission_bps").notNull().default(800),
  createdAt: createdAt(),
}).enableRLS();

export const events = pgTable(
  "events",
  {
    // Also the ref_id of the event's check-in stamps on-chain.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizerId: uuid("organizer_id").references(() => organizers.id),
    source: eventSource("source").notNull(),
    lumaUrl: text("luma_url"),
    title: text("title").notNull(),
    description: text("description"),
    venue: text("venue"),
    city: text("city").notNull(),
    // IATA code of the nearest airport: the destination of flight packages.
    airport: text("airport"),
    country: text("country").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // Null for free Luma events Estela only sells travel around.
    ticketPrice: amount("ticket_price"),
    currency: currency("currency").notNull(),
    capacity: integer("capacity"),
    // e.g. { fullRefundUntilHours: 72, organizerKeepsBps: 5000 }
    refundPolicy: jsonb("refund_policy"),
    status: eventStatus("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [index("events_starts_at_idx").on(t.startsAt)],
).enableRLS();

export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  eventId: bigint("event_id", { mode: "number" }).references(() => events.id),
  kind: bookingKind("kind").notNull(),
  currency: currency("currency").notNull(),
  // Duffel offer / stays quote ids and passenger counts behind this price.
  items: jsonb("items").notNull(),
  cost: amount("cost").notNull(),
  price: amount("price").notNull(),
  payeeAmount: amount("payee_amount").notNull().default("0"),
  discountBps: integer("discount_bps").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}).enableRLS();

export const bookings = pgTable(
  "bookings",
  {
    // Same id as the on-chain EstelaEscrow booking.
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    quoteId: uuid("quote_id").notNull().references(() => quotes.id),
    eventId: bigint("event_id", { mode: "number" }).references(() => events.id),
    kind: bookingKind("kind").notNull(),
    currency: currency("currency").notNull(),
    tokenContract: text("token_contract").notNull(),
    amount: amount("amount").notNull(),
    payee: text("payee"),
    payeeAmount: amount("payee_amount").notNull().default("0"),
    payBefore: timestamp("pay_before", { withTimezone: true }).notNull(),
    refundUntil: timestamp("refund_until", { withTimezone: true }).notNull(),
    confirmBy: timestamp("confirm_by", { withTimezone: true }).notNull(),
    // Drives the Trip stamp once it has passed.
    returnDate: date("return_date"),
    status: bookingStatus("status").notNull().default("escrow_created"),
    duffelOrderId: text("duffel_order_id"),
    duffelStaysBookingId: text("duffel_stays_booking_id"),
    // { create, fund, release | refund } transaction hashes.
    txHashes: jsonb("tx_hashes").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bookings_user_idx").on(t.userId), index("bookings_status_idx").on(t.status)],
).enableRLS();

export const tickets = pgTable("tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: bigint("booking_id", { mode: "number" }).notNull().references(() => bookings.id),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  // Key for the rotating check-in QR (HMAC per 60 s window).
  qrSecret: text("qr_secret").notNull(),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedInBy: uuid("checked_in_by").references(() => users.id),
  createdAt: createdAt(),
}).enableRLS();

export const stamps = pgTable(
  "stamps",
  {
    // EstelaStamps token id.
    tokenId: integer("token_id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    kind: stampKind("kind").notNull(),
    // Event id (event stamps) or booking id (trip stamps).
    refId: bigint("ref_id", { mode: "number" }).notNull(),
    txHash: text("tx_hash").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("stamps_user_kind_ref_idx").on(t.userId, t.kind, t.refId)],
).enableRLS();

// Mirror of every XP change seen on-chain, to reconcile and to show history.
export const xpLedger = pgTable("xp_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  delta: integer("delta").notNull(),
  total: integer("total").notNull(),
  reason: text("reason").notNull(),
  bookingId: bigint("booking_id", { mode: "number" }).references(() => bookings.id),
  txHash: text("tx_hash"),
  createdAt: createdAt(),
}).enableRLS();

// Where the chain indexer left off, per contract (RPC keeps events ~7 days).
export const chainCursor = pgTable("chain_cursor", {
  contract: text("contract").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// Signed SEP-10 challenges already exchanged for a session, so none is replayed.
export const authChallenges = pgTable("auth_challenges", {
  txHash: text("tx_hash").primaryKey(),
  account: text("account").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
