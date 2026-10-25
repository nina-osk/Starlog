import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

// Supabase's transaction pooler doesn't support prepared statements.
let client: ReturnType<typeof postgres> | undefined;

export function db() {
  client ??= postgres(env().DATABASE_URL, { prepare: false });
  return drizzle(client, { schema });
}

export { schema };
