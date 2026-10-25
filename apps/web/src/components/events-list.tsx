"use client";

import { usePollar } from "@pollar/react";
import { useCallback, useEffect, useState } from "react";
import { post } from "@/lib/api";
import { confirmWithRetry } from "@/lib/bookings";
import { formatAmount } from "@/server/pricing";
import { FlightPackage } from "./flight-package";

type EventItem = {
  id: number;
  title: string;
  description: string | null;
  venue: string | null;
  city: string;
  airport: string | null;
  startsAt: string;
  ticketPrice: string | null;
  currency: string;
};

type Membership = { xp: number; level: string; discountBps: number; passId: number | null };

type Started = {
  bookingId: number;
  /** Null when the booking was already paid and only needs confirming. */
  fundXdr: string | null;
  alreadyPaid: boolean;
  price: { amount: string; discount: string };
};

type Purchase = { busy: boolean; message?: string; error?: string };

const LEVEL_NAMES: Record<string, string> = {
  Explorer: "Explorer",
  Voyager: "Voyager",
  Globetrotter: "Globetrotter",
  Legend: "Legend",
};

/** Upcoming events with a "buy ticket" flow: reserve, pay with Pollar, confirm. */
export function EventsList({ signedIn, onPurchased }: { signedIn: boolean; onPurchased: () => void }) {
  const { signAndSubmitTx } = usePollar();
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [purchases, setPurchases] = useState<Record<number, Purchase>>({});

  useEffect(() => {
    fetch("/api/events")
      .then((res) => (res.ok ? res.json() : []))
      .then(setEvents);
  }, []);

  const loadMembership = useCallback(() => {
    if (!signedIn) return setMembership(null);
    fetch("/api/me/membership")
      .then((res) => (res.ok ? res.json() : null))
      .then(setMembership);
  }, [signedIn]);

  useEffect(loadMembership, [loadMembership]);

  const track = (id: number, p: Purchase) => setPurchases((all) => ({ ...all, [id]: p }));

  async function buy(event: EventItem) {
    track(event.id, { busy: true, message: "Reservando en el escrow…" });
    try {
      const started = await post<Started>("/api/bookings", { eventId: event.id });

      let fundHash: string | undefined;
      if (started.fundXdr) {
        track(event.id, { busy: true, message: "Confirma el pago en Pollar…" });
        const outcome = await signAndSubmitTx(started.fundXdr);
        if (outcome.status !== "success" && outcome.status !== "pending") {
          const detail = "details" in outcome ? outcome.details : undefined;
          throw new Error(`Pollar no envió el pago (${outcome.status}${detail ? `: ${detail}` : ""})`);
        }
        fundHash = outcome.hash;
      }

      track(event.id, { busy: true, message: "Pago recibido. Confirmando la reserva…" });
      const confirmed = await confirmWithRetry(started.bookingId, fundHash);
      const saved = BigInt(started.price.discount) > BigInt(0)
        ? ` Ahorraste ${formatAmount(BigInt(started.price.discount))} ${event.currency} por tu nivel.`
        : "";
      track(event.id, {
        busy: false,
        message: `¡Listo! Reserva #${confirmed.bookingId} confirmada y ticket emitido.${saved}`,
      });
      loadMembership();
      onPurchased();
    } catch (err) {
      track(event.id, { busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (events === null) return <p className="text-sm opacity-70">Cargando eventos…</p>;

  return (
    <section className="w-full max-w-xl flex flex-col gap-4">
      {membership && (
        <div className="rounded-xl border border-black/10 dark:border-white/15 p-4 text-sm flex flex-col gap-3">
          {membership.passId !== null && (
            // eslint-disable-next-line @next/next/no-img-element -- dynamic SVG from our API
            <img
              src={`/api/meta/pass/${membership.passId}/image?xp=${membership.xp}`}
              alt={`Estela Pass nivel ${membership.level}`}
              width={400}
              height={250}
              className="w-full h-auto rounded-xl"
            />
          )}
          <div>
            <p className="font-medium">Estela Pass · {LEVEL_NAMES[membership.level] ?? membership.level}</p>
            <p className="opacity-70">
              {membership.xp} XP · descuento {membership.discountBps / 100}% en tus próximas reservas
              {membership.passId === null && " · tu pase se crea con tu primera reserva"}
            </p>
          </div>
        </div>
      )}

      {events.length === 0 && <p className="text-sm opacity-70">No hay eventos próximos.</p>}

      {events.map((event) => {
        const purchase = purchases[event.id];
        return (
          <article key={event.id} className="rounded-xl border border-black/10 dark:border-white/15 p-4 flex flex-col gap-2">
            <h2 className="text-lg font-semibold">{event.title}</h2>
            <p className="text-sm opacity-70">
              {new Date(event.startsAt).toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" })} ·{" "}
              {[event.venue, event.city].filter(Boolean).join(", ")}
            </p>
            {event.description && <p className="text-sm">{event.description}</p>}
            {event.ticketPrice && (
              <div className="flex items-center gap-3 mt-1">
                <span className="font-medium">
                  {formatAmount(BigInt(event.ticketPrice))} {event.currency}
                </span>
                <button
                  onClick={() => buy(event)}
                  disabled={!signedIn || purchase?.busy}
                  className="rounded-full bg-foreground text-background px-4 h-9 text-sm font-medium disabled:opacity-40"
                >
                  {signedIn ? "Comprar ticket" : "Entra para comprar"}
                </button>
              </div>
            )}
            {purchase?.message && <p className="text-sm">{purchase.message}</p>}
            {purchase?.error && <p className="text-sm text-red-600">{purchase.error}</p>}
            {signedIn && event.airport && (
              <FlightPackage
                event={event}
                onBooked={() => {
                  loadMembership();
                  onPurchased();
                }}
              />
            )}
          </article>
        );
      })}
    </section>
  );
}
