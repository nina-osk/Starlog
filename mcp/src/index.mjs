#!/usr/bin/env node
// Estela MCP server (stdio): lets an AI agent find Stellar events, search and quote
// flights (paid per call with x402, in USDC) and book trips through Estela's escrow.
//   ESTELA_AGENT_SECRET=S... [ESTELA_URL=http://localhost:3000] node src/index.mjs
// stdout belongs to the MCP protocol: only log to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EstelaClient, units } from "./estela.mjs";

const secret = process.env.ESTELA_AGENT_SECRET;
if (!secret?.startsWith("S")) {
  console.error("ESTELA_AGENT_SECRET (the agent's S... Stellar key) is required");
  process.exit(1);
}
const estela = new EstelaClient({ baseUrl: process.env.ESTELA_URL ?? "http://localhost:3000", secret });

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (err) => ({ isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] });
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    console.error(err);
    return failure(err);
  }
};

const server = new McpServer({ name: "estela", version: "0.1.0" });

server.registerTool(
  "buscar_eventos",
  {
    title: "Buscar eventos",
    description: "Lista los próximos eventos del ecosistema Stellar que vende Estela (gratis): ciudad, aeropuerto más cercano (IATA), fecha y precio del ticket.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => {
    const { events } = await estela.events();
    return text(
      events.map((e) => ({
        evento_id: e.id,
        titulo: e.title,
        ciudad: e.city,
        aeropuerto: e.airport,
        empieza: e.startsAt,
        ticket: e.ticketPrice ? `${units(e.ticketPrice)} ${e.currency}` : null,
      })),
    );
  }),
);

server.registerTool(
  "buscar_vuelos",
  {
    title: "Buscar vuelos",
    description:
      "Busca vuelos (un adulto, turista, el más barato primero). Cuesta 0,01 USDC por búsqueda, pagados automáticamente desde la wallet del agente con x402; si la búsqueda falla no se cobra.",
    inputSchema: {
      origen: z.string().regex(/^[A-Za-z]{3}$/).describe("Aeropuerto de salida, código IATA (p. ej. LIS)"),
      destino: z.string().regex(/^[A-Za-z]{3}$/).describe("Aeropuerto de llegada, código IATA (p. ej. MAD)"),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha de salida AAAA-MM-DD"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ origen, destino, fecha }) => {
    const { offers } = await estela.searchFlights({ origin: origen, destination: destino, departureDate: fecha });
    return text(
      offers.map((o) => ({
        offer_id: o.id,
        aerolinea: o.airline,
        precio: `${o.totalAmount} ${o.totalCurrency}`,
        vence: o.expiresAt,
        tramos: o.slices[0].segments.map((s) => `${s.from}→${s.to} ${s.departingAt} (${s.carrier} ${s.flight})`),
      })),
    );
  }),
);

server.registerTool(
  "cotizar",
  {
    title: "Cotizar paquete",
    description:
      "Precio exacto de un vuelo (y opcionalmente el ticket de un evento) tal como lo cobraría Estela: vuelo + cargo de servicio + ticket − descuento del Estela Pass. Cuesta 0,005 USDC (x402).",
    inputSchema: {
      offer_id: z.string().startsWith("off_").describe("offer_id devuelto por buscar_vuelos"),
      evento_id: z.number().int().positive().optional().describe("Incluir el ticket de este evento"),
      moneda: z.enum(["EURC", "USDC", "XLM"]).default("XLM").describe("Moneda de pago (XLM solo en la demo de testnet)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ offer_id, evento_id, moneda }) => text(await estela.quote({ offerId: offer_id, eventId: evento_id, payWith: moneda }))),
);

server.registerTool(
  "reservar",
  {
    title: "Reservar viaje",
    description:
      "Reserva el vuelo (y el ticket del evento si se indica) y PAGA desde la wallet del agente al escrow de Estela: el dinero solo se libera cuando la aerolínea confirma; si no, se devuelve completo. GASTA DINERO: antes de llamar, confirma con el usuario el precio total (usa cotizar) y los datos del pasajero, que debe ser mayor de 18 años.",
    inputSchema: {
      offer_id: z.string().startsWith("off_"),
      evento_id: z.number().int().positive().optional().describe("Incluir el ticket de este evento"),
      moneda: z.enum(["EURC", "USDC", "XLM"]).default("XLM"),
      pasajero: z.object({
        tratamiento: z.enum(["sr", "sra"]),
        nombre: z.string().min(1),
        apellidos: z.string().min(1),
        nacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha de nacimiento AAAA-MM-DD (no la del viaje)"),
        email: z.string().email(),
        telefono: z.string().regex(/^\+[1-9]\d{6,14}$/).describe("Formato internacional, p. ej. +34600000000"),
      }),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ offer_id, evento_id, moneda, pasajero }) => {
    const booked = await estela.book({
      offerId: offer_id,
      eventId: evento_id,
      payWith: moneda,
      passenger: {
        title: pasajero.tratamiento === "sr" ? "mr" : "ms",
        gender: pasajero.tratamiento === "sr" ? "m" : "f",
        givenName: pasajero.nombre,
        familyName: pasajero.apellidos,
        bornOn: pasajero.nacimiento,
        email: pasajero.email,
        phoneNumber: pasajero.telefono,
      },
    });
    return text({
      reserva: booked.bookingId,
      estado: booked.status,
      localizador_vuelo: booked.bookingReference,
      ticket_evento: booked.ticketId ? "emitido" : null,
      pagado: `${units(booked.amount)} ${moneda}`,
      tx_pago: booked.fundHash ? `https://stellar.expert/explorer/testnet/tx/${booked.fundHash}` : null,
    });
  }),
);

server.registerTool(
  "mi_estela_pass",
  {
    title: "Mi Estela Pass",
    description: "Nivel, XP, descuento y tickets del agente en Estela (gratis).",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => text(await estela.pass())),
);

await server.connect(new StdioServerTransport());
console.error(`Estela MCP ready (agent ${estela.wallet.slice(0, 8)}…)`);
