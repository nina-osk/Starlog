"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

type Ticket = {
  ticketId: string;
  bookingId: number;
  checkedInAt: string | null;
  title: string;
  startsAt: string;
  venue: string | null;
  city: string;
};

// Codes rotate every minute on the server; refreshing more often keeps the one on
// screen valid when staff scans it.
const QR_REFRESH_MS = 20_000;

/** The traveler's tickets, each with its rotating check-in QR. */
export function MyTickets({ refreshKey }: { refreshKey: number }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me/tickets")
      .then((res) => (res.ok ? res.json() : []))
      .then(setTickets);
  }, [refreshKey]);

  if (!tickets || tickets.length === 0) return null;

  return (
    <section className="w-full max-w-xl flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Mis tickets</h2>
      {tickets.map((t) => (
        <article key={t.ticketId} className="rounded-xl border border-black/10 dark:border-white/15 p-4 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">{t.title}</p>
              <p className="text-sm opacity-70">
                {new Date(t.startsAt).toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" })} ·{" "}
                {[t.venue, t.city].filter(Boolean).join(", ")} · reserva #{t.bookingId}
              </p>
            </div>
            {t.checkedInAt ? (
              <span className="text-sm text-green-700 dark:text-green-400 whitespace-nowrap">Check-in hecho ✓</span>
            ) : (
              <button
                onClick={() => setOpen(open === t.ticketId ? null : t.ticketId)}
                className="rounded-full border border-black/15 dark:border-white/20 px-3 h-8 text-sm whitespace-nowrap"
              >
                {open === t.ticketId ? "Ocultar QR" : "Mostrar QR"}
              </button>
            )}
          </div>
          {open === t.ticketId && !t.checkedInAt && <TicketQr ticketId={t.ticketId} />}
        </article>
      ))}
    </section>
  );
}

function TicketQr({ ticketId }: { ticketId: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/tickets/${ticketId}/qr`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        const url = await QRCode.toDataURL(data.payload, { width: 240, margin: 1 });
        if (alive) {
          setPayload(data.payload);
          setImage(url);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(load, QR_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ticketId]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!image) return <p className="text-sm opacity-70">Generando QR…</p>;
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL, nothing to optimize */}
      <img src={image} alt="QR de check-in" width={240} height={240} className="rounded-lg bg-white p-2" />
      <p className="text-xs opacity-60 text-center">Muéstralo en la entrada. Cambia cada minuto.</p>
      <details className="text-xs opacity-60">
        <summary className="cursor-pointer">Código para pegar a mano</summary>
        <code className="break-all">{payload}</code>
      </details>
    </div>
  );
}
