"use client";

import { usePollar } from "@pollar/react";
import { useCallback, useEffect, useRef, useState } from "react";

type EstelaUser = { userId?: string; id?: string; wallet: string; role: string };

/**
 * Two-step sign-in: Pollar logs the user in and gives them a wallet, then the wallet
 * signs Estela's SEP-10 challenge so our backend knows which address it is talking
 * to and opens its own session cookie.
 */
export function LoginPanel() {
  const { isAuthenticated, verified, wallet, openLoginModal, logout, getClient } = usePollar();
  const [user, setUser] = useState<EstelaUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only try automatically once per address, so a failure doesn't loop.
  const attempted = useRef<string | null>(null);
  // Pollar's own login progress, shown while we debug the Google sign-in.
  const [pollarStep, setPollarStep] = useState<string>("idle");
  const [pollarError, setPollarError] = useState<string | null>(null);

  useEffect(() => {
    const client = getClient();
    const show = (s: ReturnType<typeof client.getAuthState>) => {
      setPollarStep(s.step);
      setPollarError(s.step === "error" ? `${s.message} (${s.errorCode}, en ${s.previousStep})` : null);
      console.info("[Estela] Pollar auth:", s.step, s.step === "error" ? s : "");
    };
    show(client.getAuthState());
    return client.onAuthStateChange(show);
  }, [getClient]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .finally(() => setChecked(true));
  }, []);

  const linkSession = useCallback(async () => {
    if (!wallet?.address) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = await post("/api/auth/challenge", { account: wallet.address });
      const proof = await getClient().stellar.sep10.sign({
        challengeXdr: challenge.transaction,
        homeDomains: challenge.homeDomain,
        webAuthDomain: challenge.webAuthDomain,
      });
      if (proof.status !== "signed") {
        throw new Error(proof.details ?? proof.code ?? "Pollar no firmó el challenge");
      }
      setUser(await post("/api/auth/verify", { transaction: proof.signedXdr }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [wallet?.address, getClient]);

  useEffect(() => {
    const address = wallet?.address;
    if (!checked || !isAuthenticated || !verified || !address) return;
    if (user?.wallet === address || attempted.current === address) return;
    attempted.current = address;
    void linkSession();
  }, [checked, isAuthenticated, verified, wallet?.address, user?.wallet, linkSession]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    attempted.current = null;
    logout();
  }

  if (!checked) return <p className="text-sm opacity-70">Cargando…</p>;

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center gap-3 text-sm">
        <button
          onClick={openLoginModal}
          className="rounded-full bg-foreground text-background px-6 h-12 font-medium"
        >
          Entrar con Pollar
        </button>
        <p className="font-mono opacity-60">Pollar: {pollarStep}</p>
        {pollarError && <p className="text-red-600 max-w-md text-center">{pollarError}</p>}
      </div>
    );
  }

  if (wallet?.custody === "smart") {
    return <p className="text-sm">Las wallets con passkey aún no están soportadas. Entra con Google o email.</p>;
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Wallet: <code className="font-mono">{wallet?.address ?? "creando…"}</code>
      </p>
      {user ? (
        <p>
          Sesión de Estela activa · rol <strong>{user.role}</strong>
        </p>
      ) : (
        <p>{busy ? "Firmando el acceso a Estela…" : "Falta vincular la sesión de Estela."}</p>
      )}
      {error && (
        <p className="text-red-600">
          {error}{" "}
          <button onClick={linkSession} className="underline">
            Reintentar
          </button>
        </p>
      )}
      <button onClick={signOut} className="self-start underline">
        Cerrar sesión
      </button>
    </div>
  );
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
