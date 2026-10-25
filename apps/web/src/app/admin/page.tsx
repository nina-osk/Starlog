"use client";

import { useCallback, useEffect, useState } from "react";
import { post } from "@/lib/api";
import { formatAmount } from "@/server/pricing";

type Booking = {
  id: number;
  kind: string;
  status: string;
  currency: string;
  amount: string;
  payeeAmount: string;
  bookingReference: string | null;
  createdAt: string;
  wallet: string;
  event: string | null;
};

type Treasury = { address: string; balances: { asset: string; balance: string }[] };

const STATUS_COLORS: Record<string, string> = {
  confirmed: "text-green-700 dark:text-green-400",
  refunded: "text-amber-700 dark:text-amber-400",
  failed: "text-red-600",
  expired: "opacity-50",
};

const KIND_NAMES: Record<string, string> = { ticket: "Ticket", package: "Vuelo + ticket", travel: "Vuelo" };

/** Operations: bookings, manual refunds of funds still in escrow, treasury balances. */
export default function Admin() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, t] = await Promise.all([fetch("/api/admin/bookings"), fetch("/api/admin/treasury")]);
    if (b.status === 401 || b.status === 403) {
      setError("Solo para administradores. Entra con una cuenta con rol admin.");
      return;
    }
    setBookings(b.ok ? await b.json() : []);
    setTreasury(t.ok ? await t.json() : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refund(b: Booking) {
    if (!window.confirm(`¿Reembolsar el 100 % de la reserva #${b.id} (${formatAmount(BigInt(b.amount))} ${b.currency}) al viajero?`)) {
      return;
    }
    setBusy(b.id);
    setNotice(null);
    try {
      await post(`/api/admin/bookings/${b.id}/refund`, {});
      setNotice(`Reserva #${b.id} reembolsada.`);
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <main className="p-8 text-sm text-red-600">{error}</main>;

  return (
    <main className="min-h-screen p-6 sm:p-8 flex flex-col gap-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold">Estela · admin</h1>

      <section className="rounded-xl border border-black/10 dark:border-white/15 p-4 text-sm">
        <h2 className="font-medium mb-2">Treasury</h2>
        {treasury ? (
          <>
            <p className="font-mono text-xs break-all opacity-70">{treasury.address}</p>
            <div className="flex flex-wrap gap-4 mt-2">
              {treasury.balances.map((b) => (
                <p key={b.asset}>
                  <span className="font-medium">{Number(b.balance).toLocaleString("es-ES", { maximumFractionDigits: 2 })}</span> {b.asset}
                </p>
              ))}
            </div>
          </>
        ) : (
          <p className="opacity-70">Cargando…</p>
        )}
      </section>

      {notice && <p className="text-sm">{notice}</p>}

      <section className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left opacity-60">
            <tr>
              <th className="py-2 pr-3">#</th>
              <th className="pr-3">Tipo</th>
              <th className="pr-3">Evento</th>
              <th className="pr-3">Viajero</th>
              <th className="pr-3 text-right">Importe</th>
              <th className="pr-3 text-right">Organizador</th>
              <th className="pr-3">Vuelo</th>
              <th className="pr-3">Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bookings?.map((b) => (
              <tr key={b.id} className="border-t border-black/5 dark:border-white/10">
                <td className="py-2 pr-3">{b.id}</td>
                <td className="pr-3">{KIND_NAMES[b.kind] ?? b.kind}</td>
                <td className="pr-3">{b.event ?? "—"}</td>
                <td className="pr-3 font-mono text-xs" title={b.wallet}>
                  {b.wallet.slice(0, 6)}…{b.wallet.slice(-4)}
                </td>
                <td className="pr-3 text-right whitespace-nowrap">
                  {formatAmount(BigInt(b.amount))} {b.currency}
                </td>
                <td className="pr-3 text-right whitespace-nowrap">
                  {BigInt(b.payeeAmount) > BigInt(0) ? formatAmount(BigInt(b.payeeAmount)) : "—"}
                </td>
                <td className="pr-3 font-mono text-xs">{b.bookingReference ?? "—"}</td>
                <td className={`pr-3 ${STATUS_COLORS[b.status] ?? ""}`}>{b.status}</td>
                <td>
                  {["escrow_created", "funded", "supplier_booking"].includes(b.status) && (
                    <button onClick={() => refund(b)} disabled={busy !== null} className="underline disabled:opacity-40">
                      {busy === b.id ? "…" : "Reembolsar"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bookings?.length === 0 && <p className="text-sm opacity-70 py-4">Todavía no hay reservas.</p>}
      </section>
    </main>
  );
}
