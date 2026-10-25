/** POSTs JSON to our API and returns the parsed answer, or throws its error message. */
export async function post<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
