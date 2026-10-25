/** POSTs JSON to our API and returns the parsed answer, or throws its error message. */
export async function post<T = unknown>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Algo salió mal. Inténtalo de nuevo.", res.status, data.code);
  return data as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stable machine-readable reason, e.g. "payment_pending" or "insufficient_balance". */
    readonly code?: string,
  ) {
    super(message);
  }
}
