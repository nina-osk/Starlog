"use client";

import { useEffect, useState } from "react";

// Only these query params are shown: they explain a failed sign-in and carry no
// credentials (codes and tokens are never displayed).
const SHOWN_PARAMS = ["error", "error_description", "error_code", "code_error", "status", "message"];

/**
 * Landing tab for Google sign-in. The login itself finishes in the tab that opened
 * this one, so here we only tell the user to go back and try to close ourselves,
 * unless the provider reported an error, which we show instead.
 */
export default function OAuthCallback() {
  const [errors, setErrors] = useState<[string, string][] | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const found = SHOWN_PARAMS.flatMap((k) => (params.has(k) ? [[k, params.get(k) ?? ""] as [string, string]] : []));
    console.info("[Estela] OAuth callback params:", [...params.keys()]);
    setErrors(found);
    if (found.length === 0) {
      // Browsers only allow this for tabs opened by script, which this one is.
      window.close();
    }
  }, []);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-3 p-8 text-center">
      {errors && errors.length > 0 ? (
        <>
          <h1 className="text-2xl font-semibold text-red-600">El inicio de sesión falló</h1>
          <ul className="font-mono text-sm">
            {errors.map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">Inicio de sesión completo</h1>
          <p className="opacity-70">Puedes cerrar esta pestaña y volver a la pestaña de Estela.</p>
        </>
      )}
    </main>
  );
}
