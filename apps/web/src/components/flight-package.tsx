"use client";

import { usePollar } from "@pollar/react";
import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { confirmWithRetry, payErrorMessage } from "@/lib/bookings";
import { formatAmount } from "@/server/pricing";

type Offer = {
  id: string;
  totalAmount: string;
  totalCurrency: string;
  airline: string;
  slices: { segments: { from: string; to: string; departingAt: string; arrivingAt: string; carrier: string; flight: string }[] }[];
};

type EventInfo = { id: number; title: string; airport: string | null; startsAt: string; currency: string; ticketPrice: string | null };

type Started = {
  bookingId: number;
  fundXdr: string | null;
  price: { amount: string; discount: string };
};

const input = "rounded-lg border border-black/15 dark:border-white/20 bg-transparent px-3 h-9 text-sm";
const time = (iso: string) => iso.slice(11, 16);

/** "Add a flight": search Duffel, pick an offer, enter the passenger, pay with Pollar. */
export function FlightPackage({ event, onBooked }: { event: EventInfo; onBooked: () => void }) {
  const { signAndSubmitTx } = usePollar();
  const dayBefore = new Date(new Date(event.startsAt).getTime() - 86_400_000).toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [date, setDate] = useState(dayBefore);
  const [withTicket, setWithTicket] = useState(Boolean(event.ticketPrice));
  // Flight-only bookings can be paid in the stablecoin matching the fare; with the
  // ticket included, the event's currency applies.
  const [flightPayWith, setFlightPayWith] = useState("EURC");
  // Travelers who already hold a ticket for this event only need the flight.
  const [hasTicket, setHasTicket] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/api/me/tickets")
      .then((res) => (res.ok ? res.json() : []))
      .then((tickets: { eventId: number }[]) => {
        const owned = tickets.some((t) => Number(t.eventId) === event.id);
        setHasTicket(owned);
        if (owned) setWithTicket(false);
      });
  }, [open, event.id]);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [chosen, setChosen] = useState<Offer | null>(null);
  const [pax, setPax] = useState({ title: "ms", gender: "f", givenName: "", familyName: "", bornOn: "", email: "", phoneNumber: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOffers(null);
    setChosen(null);
    setBusy("Buscando vuelos…");
    try {
      setOffers(await post<Offer[]>("/api/flights/search", { origin, destination: event.airport, departureDate: date }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setError(null);
    try {
      setBusy("Reservando en el escrow…");
      const started = await post<Started>("/api/bookings/package", {
        offerId: chosen.id,
        payWith,
        eventId: withTicket ? event.id : undefined,
        passenger: pax,
      });
      let fundHash: string | undefined;
      if (started.fundXdr) {
        setBusy(`Confirma en Pollar el pago de ${formatAmount(BigInt(started.price.amount))} ${payWith}…`);
        const outcome = await signAndSubmitTx(started.fundXdr);
        if (outcome.status !== "success" && outcome.status !== "pending") {
          console.warn("Pollar did not send the payment", outcome);
          throw new Error(payErrorMessage(outcome));
        }
        fundHash = outcome.hash;
      }
      setBusy("Pago recibido. Comprando el vuelo…");
      const confirmed = await confirmWithRetry<{ bookingReference: string | null }>(started.bookingId, fundHash);
      setDone(
        `¡Listo! Reserva #${started.bookingId} confirmada. Localizador del vuelo: ${confirmed.bookingReference ?? "—"}` +
          (withTicket ? " · ticket emitido." : "."),
      );
      setChosen(null);
      setOffers(null);
      onBooked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const payWith = withTicket ? event.currency : flightPayWith;
  // Adults only (18+); the server re-checks against the actual flight date.
  const adultCutoff = new Date();
  adultCutoff.setFullYear(adultCutoff.getFullYear() - 18);
  const latestBirthDate = adultCutoff.toISOString().slice(0, 10);
  const stablecoin = chosen?.totalCurrency === "USD" ? "USDC" : "EURC";

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="self-start text-sm underline mt-1">
        ✈ Añadir vuelo a {event.airport}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg bg-black/[.03] dark:bg-white/[.04] p-3 flex flex-col gap-3 text-sm">
      <form onSubmit={search} className="flex flex-wrap items-center gap-2">
        <input
          value={origin}
          onChange={(e) => setOrigin(e.target.value.toUpperCase().slice(0, 3))}
          placeholder="Origen (LIS)"
          className={`${input} w-28 uppercase`}
          required
        />
        <span>→ {event.airport}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
        <button disabled={busy !== null || origin.length !== 3} className="rounded-full border px-3 h-9 disabled:opacity-40">
          Buscar
        </button>
      </form>

      {offers && offers.length === 0 && <p className="opacity-70">No hay vuelos para esa fecha.</p>}
      {offers && offers.length > 0 && !chosen && (
        <ul className="flex flex-col gap-2">
          {offers.map((o) => {
            const segs = o.slices[0].segments;
            return (
              <li key={o.id}>
                <button
                  onClick={() => {
                    setChosen(o);
                    setFlightPayWith(o.totalCurrency === "USD" ? "USDC" : "EURC");
                  }}
                  className="w-full text-left rounded-lg border border-black/10 dark:border-white/15 p-2 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="font-medium">{segs.map((s) => s.carrier).join(" + ")}</span> · {time(segs[0].departingAt)} →{" "}
                  {time(segs.at(-1)!.arrivingAt)} · {segs.length === 1 ? "directo" : `${segs.length - 1} escala`} ·{" "}
                  <span className="font-medium">
                    {o.totalAmount} {o.totalCurrency}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {chosen && (
        <form onSubmit={book} className="flex flex-col gap-2">
          <p>
            <span className="font-medium">{chosen.airline}</span> · {chosen.totalAmount} {chosen.totalCurrency} + cargo de servicio{" "}
            <button type="button" onClick={() => setChosen(null)} className="underline">
              cambiar
            </button>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input className={input} placeholder="Nombre" value={pax.givenName} onChange={(e) => setPax({ ...pax, givenName: e.target.value })} required />
            <input className={input} placeholder="Apellidos" value={pax.familyName} onChange={(e) => setPax({ ...pax, familyName: e.target.value })} required />
            <select className={input} value={`${pax.title}/${pax.gender}`} onChange={(e) => { const [title, gender] = e.target.value.split("/"); setPax({ ...pax, title, gender }); }}>
              <option value="ms/f">Sra.</option>
              <option value="mr/m">Sr.</option>
            </select>
            <label className="flex flex-col gap-0.5 text-xs opacity-80 col-span-2 sm:col-span-1">
              Fecha de nacimiento del pasajero
              <input
                className={`${input} opacity-100`}
                type="date"
                max={latestBirthDate}
                value={pax.bornOn}
                onChange={(e) => setPax({ ...pax, bornOn: e.target.value })}
                required
              />
            </label>
            <input className={input} type="email" placeholder="Email" value={pax.email} onChange={(e) => setPax({ ...pax, email: e.target.value })} required />
            <input className={input} placeholder="Teléfono (+34…)" value={pax.phoneNumber} onChange={(e) => setPax({ ...pax, phoneNumber: e.target.value.replace(/\s/g, "") })} required />
          </div>
          {hasTicket && <p className="opacity-70">Ya tienes ticket para este evento: reservas solo el vuelo.</p>}
          {event.ticketPrice && !hasTicket && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={withTicket} onChange={(e) => setWithTicket(e.target.checked)} />
              Incluir el ticket de {event.title} ({formatAmount(BigInt(event.ticketPrice))} {event.currency})
            </label>
          )}
          {!withTicket && (
            <label className="flex items-center gap-2">
              Pagar en
              <select className={input} value={flightPayWith} onChange={(e) => setFlightPayWith(e.target.value)}>
                <option value={stablecoin}>{stablecoin}</option>
                <option value="XLM">XLM (demo)</option>
              </select>
            </label>
          )}
          <button disabled={busy !== null} className="self-start rounded-full bg-foreground text-background px-4 h-9 font-medium disabled:opacity-40">
            Reservar {withTicket ? "vuelo + ticket" : "vuelo"} · pagar en {payWith}
          </button>
        </form>
      )}

      {busy && <p className="opacity-70">{busy}</p>}
      {error && <p className="text-red-600">{error}</p>}
      {done && <p className="text-green-700 dark:text-green-400">{done}</p>}
    </div>
  );
}
