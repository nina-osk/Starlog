# Estela MCP

MCP server (stdio) that lets an AI agent travel to Stellar events with Estela:

| Tool | What it does | Cost |
|---|---|---|
| `buscar_eventos` | Upcoming events (city, airport, date, ticket price) | free |
| `buscar_vuelos` | Flight offers, cheapest first | 0.01 USDC per call (x402) |
| `cotizar` | Exact package price (flight + service fee + ticket − Estela Pass discount) | 0.005 USDC (x402) |
| `reservar` | Books and pays **through Estela's escrow** (refunded in full if the airline doesn't confirm) | the trip |
| `mi_estela_pass` | Agent's level, XP, discount and tickets | free |

The agent is a Stellar account whose secret key the server holds: it pays x402 calls
in USDC (no XLM needed, the facilitator sponsors fees), signs in to Estela with SEP-10
and signs escrow payments itself. On testnet it needs a USDC trustline + test USDC
(faucet.circle.com) for searches, and XLM (or EURC/USDC) for bookings.

## Run

```bash
npm install
ESTELA_AGENT_SECRET=S... ESTELA_URL=http://localhost:3000 npm start
```

## Add to Claude Code

```bash
claude mcp add estela \
  --env ESTELA_AGENT_SECRET=S... \
  --env ESTELA_URL=http://localhost:3000 \
  -- node /absolute/path/to/mcp/src/index.mjs
```

The secret ends up in your local Claude config: use a testnet agent account, never a
wallet holding real funds.

## Test

```bash
ESTELA_AGENT_SECRET=S... node test/e2e.mjs                # free + paid reads (~0.015 USDC)
ESTELA_AGENT_SECRET=S... RUN_BOOKING=1 node test/e2e.mjs  # also books a flight (testnet XLM)
```
