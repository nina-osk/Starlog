import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests that hit Stellar testnet: slow and need .env.local, so they don't run
// with `npm test`. Run with `npm run test:testnet`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js guards server modules with this import; outside Next it's a no-op.
      "server-only": fileURLToPath(new URL("./src/server/testing/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.testnet.ts"],
  },
});
