import { defineConfig } from "drizzle-kit";

// Migrations run against Supabase's direct/session connection (port 5432), not the
// transaction pooler the app uses.
export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "",
  },
});
