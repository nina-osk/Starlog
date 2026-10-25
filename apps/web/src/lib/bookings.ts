import { ApiError, post } from "./api";

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
      const stillPending = err instanceof ApiError && err.status === 409 && err.message.includes("hasn't arrived");
      if (!stillPending || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}
