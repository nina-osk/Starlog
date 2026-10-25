// Gives a signed-up user a role: traveler | organizer | staff | admin.
// Run from apps/web: node --env-file=.env.local scripts/set-role.mjs <G... wallet> <role>
// Takes effect immediately: role checks read the database, not the session cookie.
import postgres from "postgres";

const [wallet, role] = process.argv.slice(2);
const roles = ["traveler", "organizer", "staff", "admin"];
if (!/^G[A-Z2-7]{55}$/.test(wallet ?? "") || !roles.includes(role)) {
  console.error(`usage: set-role.mjs <G... wallet> <${roles.join("|")}>`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  const rows = await sql`update users set role = ${role} where wallet = ${wallet} returning wallet, role`;
  console.log(rows.length ? `${rows[0].wallet} is now ${rows[0].role}` : "no user with that wallet (sign in once first)");
} finally {
  await sql.end();
}
