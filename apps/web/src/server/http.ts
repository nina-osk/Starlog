import "server-only";
import { NextResponse } from "next/server";
import { BookingError } from "./bookings";
import { ChainError } from "./chain";

/** JSON that may contain bigints (token amounts), sent as strings. */
export function json(data: unknown, init?: ResponseInit) {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new NextResponse(body, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
}

/** Maps domain errors to HTTP answers; anything else is a 500. */
export function errorResponse(err: unknown) {
  if (err instanceof BookingError) return json({ error: err.message }, { status: err.status });
  if (err instanceof ChainError) {
    console.error(err);
    return json({ error: err.message }, { status: 502 });
  }
  console.error(err);
  return json({ error: "internal error" }, { status: 500 });
}

export const unauthorized = () => json({ error: "sign in first" }, { status: 401 });
