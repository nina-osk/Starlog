import "server-only";
import { NextResponse } from "next/server";
import { BookingError } from "./bookings";
import { ChainError } from "./chain";
import { DuffelError } from "./duffel";

/** JSON that may contain bigints (token amounts), sent as strings. */
export function json(data: unknown, init?: ResponseInit) {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new NextResponse(body, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
}

// Token contracts reject transfers the sender can't cover with error #10
// (BalanceError) or a "balance" message; show that as what it is.
const INSUFFICIENT = /Error\(Contract, #10\)|insufficient|balance is not sufficient|not enough balance/i;

/**
 * Maps errors to HTTP answers with a message the traveler can act on. Technical
 * details only go to the server log.
 */
export function errorResponse(err: unknown) {
  if (err instanceof BookingError) {
    return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
  }
  console.error(err);
  if (err instanceof ChainError) {
    if (INSUFFICIENT.test(err.message)) {
      return json({ error: "Saldo insuficiente para completar el pago.", code: "insufficient_balance" }, { status: 402 });
    }
    return json(
      { error: "No pudimos completar la operación en la red Stellar. Inténtalo de nuevo en unos minutos.", code: "chain_error" },
      { status: 502 },
    );
  }
  if (err instanceof DuffelError) {
    return json(
      { error: "El proveedor de vuelos no respondió como esperábamos. Inténtalo de nuevo.", code: "supplier_error" },
      { status: 502 },
    );
  }
  return json({ error: "Algo salió mal. Inténtalo de nuevo.", code: "internal_error" }, { status: 500 });
}

export const unauthorized = () => json({ error: "Inicia sesión para continuar." }, { status: 401 });
