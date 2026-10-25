// Drives the Estela MCP server exactly like an MCP host (Claude) would, over stdio.
//   ESTELA_AGENT_SECRET=S... [RUN_BOOKING=1] node test/e2e.mjs
// Without RUN_BOOKING only free and x402-paid read tools run (≈0.015 USDC).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "estela-e2e", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["src/index.mjs"], env: { ...process.env }, stderr: "inherit" }),
);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content[0].text;
  if (res.isError) throw new Error(`${name}: ${body}`);
  return JSON.parse(body);
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}${t.annotations?.destructiveHint ? " (gasta dinero)" : ""}`).join(", "));

const [event] = (await call("buscar_eventos")).filter((e) => e.aeropuerto);
console.log(`buscar_eventos → ${event.titulo} (${event.aeropuerto}), ticket ${event.ticket}`);

const date = new Date(new Date(event.empieza).getTime() - 86_400_000).toISOString().slice(0, 10);
const flights = await call("buscar_vuelos", { origen: "LIS", destino: event.aeropuerto, fecha: date });
const flight = flights[0];
console.log(`buscar_vuelos → ${flights.length} vuelos; ${flight.aerolinea} ${flight.precio}`);

const quote = await call("cotizar", { offer_id: flight.offer_id, moneda: "XLM" });
console.log(`cotizar → total ${quote.total} ${quote.currency} (vuelo ${quote.breakdown.flight} + cargo ${quote.breakdown.serviceFee})`);

if (process.env.RUN_BOOKING === "1") {
  const booked = await call("reservar", {
    offer_id: flight.offer_id,
    moneda: "XLM",
    pasajero: {
      tratamiento: "sra", nombre: "Agente", apellidos: "MCP", nacimiento: "1991-07-19",
      email: "agente.mcp@example.com", telefono: "+34600000010",
    },
  });
  console.log(`reservar → reserva #${booked.reserva} ${booked.estado}, localizador ${booked.localizador_vuelo}, pagado ${booked.pagado}`);
}

// Validation errors come back as tool errors, not crashes.
const bad = await client.callTool({ name: "buscar_vuelos", arguments: { origen: "LISBOA", destino: "MAD", fecha: date } });
console.log(`entrada inválida → isError=${bad.isError}`);

const pass = await call("mi_estela_pass");
console.log(`mi_estela_pass → ${pass.level}, ${pass.xp} XP, ${pass.tickets.length} ticket(s)`);
await client.close();
