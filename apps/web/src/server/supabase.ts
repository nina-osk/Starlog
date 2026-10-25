import "server-only";
import { createAdminClient } from "@supabase/server/core";

// Supabase API client for server code (Storage, etc.). It uses the secret key and
// bypasses RLS, so it must never reach the browser; "server-only" enforces that.
// Reads SUPABASE_URL and SUPABASE_SECRET_KEY from the environment.
// Table reads/writes go through Drizzle (src/server/db) instead.
let client: ReturnType<typeof createAdminClient> | undefined;

export function supabaseAdmin() {
  client ??= createAdminClient();
  return client;
}
