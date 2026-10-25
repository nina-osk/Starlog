import { createHmac, timingSafeEqual } from "node:crypto";

// Rotating check-in codes: "<ticketId>.<window>.<mac>", where window is the current
// 60 s slot and mac an HMAC of both under the ticket's secret. A screenshot stops
// working within a minute, and only the server (which holds the secret) can mint or
// check codes.

export const QR_WINDOW_MS = 60_000;

const window = (now: number) => Math.floor(now / QR_WINDOW_MS);

function mac(secret: string, ticketId: string, slot: number): string {
  return createHmac("sha256", secret).update(`${ticketId}:${slot}`).digest("base64url").slice(0, 22);
}

export function qrPayload(ticketId: string, secret: string, now = Date.now()): string {
  const slot = window(now);
  return `${ticketId}.${slot}.${mac(secret, ticketId, slot)}`;
}

/** Splits a scanned code; null if it isn't one of ours. */
export function parseQr(payload: string): { ticketId: string; slot: number; mac: string } | null {
  const parts = payload.trim().split(".");
  if (parts.length !== 3) return null;
  const [ticketId, slotText, code] = parts;
  const slot = Number(slotText);
  if (!/^[0-9a-f-]{36}$/i.test(ticketId) || !Number.isSafeInteger(slot) || !/^[\w-]{22}$/.test(code)) return null;
  return { ticketId, slot, mac: code };
}

/**
 * True if the code was minted with `secret` for the current window or the previous
 * one (the scanner may read a code a few seconds before it rotates).
 */
export function verifyQr(payload: string, secret: string, now = Date.now()): boolean {
  const parsed = parseQr(payload);
  if (!parsed) return false;
  const current = window(now);
  if (parsed.slot !== current && parsed.slot !== current - 1) return false;
  const expected = Buffer.from(mac(secret, parsed.ticketId, parsed.slot));
  const given = Buffer.from(parsed.mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
