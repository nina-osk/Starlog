import { ApiError, post } from "./api";

/**
 * A traveler-friendly reason for a payment Pollar didn't send (`signAndSubmitTx`
 * outcome that isn't success/pending).
 */
export function payErrorMessage(outcome: { status: string; code?: string; details?: string }): string {
  const text = `${outcome.code ?? ""} ${outcome.details ?? ""}`;
  if (/insufficient|underfunded|balance|#10\b|op_underfunded/i.test(text)) return "Saldo insuficiente en tu wallet.";
  if (/declin|reject|cancel/i.test(text)) return "Cancelaste el pago.";
  if (outcome.status === "cosign_pending") return "El pago está esperando tu aprobación en otro dispositivo.";
  return "No se pudo enviar el pago desde tu wallet. Inténtalo de nuevo.";
}

/**
 * Confirms a paid booking. The fund transaction can take a few seconds to land
 * (409 meanwhile), so this retries for a while.
 */
export async function confirmWithRetry<T = { bookingId: number }>(
  bookingId: number,
  fundHash: string | undefined,
  attempts = 6,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await post<T>(`/api/bookings/${bookingId}/confirm`, { fundHash });
    } catch (err) {
      const stillPending = err instanceof ApiError && err.code === "payment_pending";
      if (!stillPending || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}
