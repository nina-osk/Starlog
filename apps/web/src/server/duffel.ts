import "server-only";
import { env } from "./env";

// Minimal Duffel Flights client. Flights are bought with `balance` payments, i.e.
// from Estela's prefunded Duffel balance (the fiat float), never with the traveler's
// card: the traveler pays Estela in crypto through the escrow.

const API = "https://api.duffel.com";

export class DuffelError extends Error {
  constructor(message: string, readonly status: number, readonly codes: string[] = []) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env().DUFFEL_TOKEN}`,
      "Duffel-Version": "v2",
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify({ data: body }) : undefined,
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors: { code?: string; message?: string; title?: string }[] = json.errors ?? [];
    const message = errors.map((e) => e.message ?? e.title).filter(Boolean).join("; ") || `HTTP ${res.status}`;
    throw new DuffelError(`Duffel: ${message}`, res.status, errors.map((e) => e.code ?? ""));
  }
  return json.data as T;
}

type Place = { iata_code: string; name: string; city_name?: string | null };
type RawSegment = {
  origin: Place;
  destination: Place;
  departing_at: string;
  arriving_at: string;
  duration: string | null;
  operating_carrier: { name: string; iata_code: string };
  marketing_carrier: { name: string; iata_code: string };
  marketing_carrier_flight_number: string;
};
type RawOffer = {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at: string;
  owner: { name: string; iata_code: string };
  slices: { segments: RawSegment[] }[];
  passengers: { id: string }[];
};

export type Offer = {
  id: string;
  totalAmount: string;
  totalCurrency: string;
  expiresAt: string;
  airline: string;
  passengerIds: string[];
  slices: {
    segments: {
      from: string;
      to: string;
      departingAt: string;
      arrivingAt: string;
      /** Operating carrier: Duffel asks to show it prominently. */
      carrier: string;
      flight: string;
    }[];
  }[];
};

function toOffer(o: RawOffer): Offer {
  return {
    id: o.id,
    totalAmount: o.total_amount,
    totalCurrency: o.total_currency,
    expiresAt: o.expires_at,
    airline: o.owner.name,
    passengerIds: o.passengers.map((p) => p.id),
    slices: o.slices.map((s) => ({
      segments: s.segments.map((g) => ({
        from: g.origin.iata_code,
        to: g.destination.iata_code,
        departingAt: g.departing_at,
        arrivingAt: g.arriving_at,
        carrier: g.operating_carrier.name,
        flight: `${g.marketing_carrier.iata_code}${g.marketing_carrier_flight_number}`,
      })),
    })),
  };
}

export type FlightSearch = {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
};

/** Cheapest offers first. */
export async function searchFlights(q: FlightSearch, limit = 8): Promise<Offer[]> {
  const slices = [{ origin: q.origin, destination: q.destination, departure_date: q.departureDate }];
  if (q.returnDate) slices.push({ origin: q.destination, destination: q.origin, departure_date: q.returnDate });
  const data = await call<{ offers: RawOffer[] }>("POST", "/air/offer_requests?return_offers=true&supplier_timeout=10000", {
    slices,
    passengers: Array.from({ length: q.adults }, () => ({ type: "adult" })),
    cabin_class: "economy",
    max_connections: 1,
  });
  return data.offers
    .sort((a, b) => Number(a.total_amount) - Number(b.total_amount))
    .slice(0, limit)
    .map(toOffer);
}

/** The offer with its latest price (offers expire and reprice). */
export async function getOffer(id: string): Promise<Offer> {
  return toOffer(await call<RawOffer>("GET", `/air/offers/${encodeURIComponent(id)}`));
}

export type Passenger = {
  id: string;
  title: "mr" | "ms" | "mrs" | "miss";
  gender: "m" | "f";
  givenName: string;
  familyName: string;
  bornOn: string;
  email: string;
  phoneNumber: string;
};

/** Books the offer, paid from Estela's Duffel balance. */
export async function createOrder(offer: Offer, passengers: Passenger[]) {
  const order = await call<{ id: string; booking_reference: string; total_amount: string; total_currency: string }>(
    "POST",
    "/air/orders",
    {
      type: "instant",
      selected_offers: [offer.id],
      payments: [{ type: "balance", amount: offer.totalAmount, currency: offer.totalCurrency }],
      passengers: passengers.map((p) => ({
        id: p.id,
        title: p.title,
        gender: p.gender,
        given_name: p.givenName,
        family_name: p.familyName,
        born_on: p.bornOn,
        email: p.email,
        phone_number: p.phoneNumber,
      })),
    },
  );
  return {
    orderId: order.id,
    bookingReference: order.booking_reference,
    totalAmount: order.total_amount,
    totalCurrency: order.total_currency,
  };
}
