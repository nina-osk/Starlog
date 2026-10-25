"use client";

import { usePollar } from "@pollar/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { post } from "@/lib/api";

export type EstelaUser = { userId?: string; id?: string; wallet: string; role: string };

type Props = {
  /** The Estela session, or null; owned by the page so other components can use it. */
  user: EstelaUser | null;
  onUserChange: (user: EstelaUser | null) => void;
};

/**
 * Two-step sign-in: Pollar logs the user in and gives them a wallet, then the wallet
 * signs Estela's SEP-10 challenge so our backend knows which address it is talking
 * to and opens its own session cookie.
 */
export function LoginPanel({ user, onUserChange }: Props) {
  const {
    isAuthenticated,
    verified,
    wallet,
    openLoginModal,
    openWalletBalanceModal,
    logout,
    getClient,
  } = usePollar();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only try automatically once per address, so a failure doesn't loop.
  const attempted = useRef<string | null>(null);
  // Pollar login failures (e.g. the app is out of credits) would otherwise only
  // show inside its modal, which the user may have closed.
  const [pollarError, setPollarError] = useState<string | null>(null);

  useEffect(() => {
    const client = getClient();
    const show = (s: ReturnType<typeof client.getAuthState>) =>
      setPollarError(s.step === "error" ? `${s.message} (${s.errorCode})` : null);
    show(client.getAuthState());
    return client.onAuthStateChange(show);
  }, [getClient]);

  const linkSession = useCallback(async () => {
    if (!wallet?.address) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = await post<{ transaction: string; homeDomain: string; webAuthDomain: string }>(
        "/api/auth/challenge",
        { account: wallet.address },
      );
      const proof = await getClient().stellar.sep10.sign({
        challengeXdr: challenge.transaction,
        homeDomains: challenge.homeDomain,
        webAuthDomain: challenge.webAuthDomain,
      });
      if (proof.status !== "signed") {
        throw new Error(proof.details ?? proof.code ?? "Pollar no firmó el challenge");
      }
      onUserChange(await post<EstelaUser>("/api/auth/verify", { transaction: proof.signedXdr }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [wallet?.address, getClient, onUserChange]);

  useEffect(() => {
    const address = wallet?.address;
    if (!isAuthenticated || !verified || !address) return;
    if (user?.wallet === address || attempted.current === address) return;
    attempted.current = address;
    void linkSession();
  }, [isAuthenticated, verified, wallet?.address, user?.wallet, linkSession]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    onUserChange(null);
    attempted.current = null;
    logout();
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center gap-3 text-sm">
        <button
          onClick={openLoginModal}
          className="rounded-full bg-foreground text-background px-6 h-12 font-medium"
        >
          Entrar con Pollar
        </button>
        {pollarError && <p className="text-red-600 max-w-md text-center">{pollarError}</p>}
      </div>
    );
  }

  if (wallet?.custody === "smart") {
    return <p className="text-sm">Las wallets con passkey aún no están soportadas. Entra con Google o email.</p>;
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
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
      {wallet?.address && (
        <button
          type="button"
          onClick={() => openWalletBalanceModal()}
          className="self-start underline"
        >
          Ver saldo
        </button>
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

