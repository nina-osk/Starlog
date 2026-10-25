// Demo data for testnet: one partner organizer and one paid event.
// Run from apps/web: node --env-file=.env.local scripts/seed-demo.mjs
// Safe to run again: existing rows are reused.
import postgres from "postgres";

// testOrganizer in deploy/testnet.json: receives the organizer's share on release.
const ORGANIZER_WALLET = "GAKMO2MGYQOR5ICOACHRB7MYBMSA6YO3H4MCULGD7HRKOSBGZNQ45NGJ";
const EVENT_TITLE = "Stellar Builders Night Madrid";
const DAY = 24 * 60 * 60 * 1000;

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  const [user] = await sql`
    insert into users (wallet, role) values (${ORGANIZER_WALLET}, 'organizer')
    on conflict (wallet) do update set role = 'organizer'
    returning id`;
  const [organizer] = await sql`
    insert into organizers (user_id, name, payout_wallet, commission_bps)
    values (${user.id}, 'Stellar Builders Madrid', ${ORGANIZER_WALLET}, 800)
    on conflict (user_id) do update set name = excluded.name
    returning id`;

  const [existing] = await sql`select id from events where title = ${EVENT_TITLE}`;
  if (existing) {
    console.log(`event already exists: #${existing.id}`);
  } else {
    const startsAt = new Date(Date.now() + 30 * DAY);
    const [event] = await sql`
      insert into events (organizer_id, source, title, description, venue, city, airport, country,
                          starts_at, ends_at, ticket_price, currency, capacity, refund_policy, status)
      values (${organizer.id}, 'partner', ${EVENT_TITLE},
              'Demos, charlas cortas y networking del ecosistema Stellar.',
              'Impact Hub Picasso', 'Madrid', 'MAD', 'ES',
              ${startsAt}, ${new Date(startsAt.getTime() + 4 * 3_600_000)},
              ${"50000000"}, 'XLM', 50, ${sql.json({ fullRefundUntilHours: 48 })}, 'published')
      returning id`;
    console.log(`event created: #${event.id} (5 XLM, organizer ${ORGANIZER_WALLET.slice(0, 8)}…)`);
  }
} finally {
  await sql.end();
}
