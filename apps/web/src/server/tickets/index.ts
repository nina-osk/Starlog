import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { Session } from "../auth/session";
import { BookingError } from "../bookings";
import * as chain from "../chain";
import { db, schema } from "../db";
import { parseQr, qrPayload, verifyQr } from "./qr";

const { bookings, events, organizers, stamps, tickets, users } = schema;

/** The signed-in traveler's tickets, newest first. */
export async function myTickets(session: Session) {
  return db()
    .select({
      ticketId: tickets.id,
      bookingId: tickets.bookingId,
      checkedInAt: tickets.checkedInAt,
      eventId: events.id,
      title: events.title,
      startsAt: events.startsAt,
      venue: events.venue,
      city: events.city,
    })
    .from(tickets)
    .innerJoin(events, eq(tickets.eventId, events.id))
    .where(eq(tickets.userId, session.userId))
    .orderBy(desc(tickets.createdAt));
}

/** A fresh rotating code for one of the traveler's own tickets. */
export async function ticketQr(session: Session, ticketId: string) {
  const [ticket] = await db()
    .select({ id: tickets.id, secret: tickets.qrSecret, checkedInAt: tickets.checkedInAt })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.userId, session.userId)));
  if (!ticket) throw new BookingError("No encontramos ese ticket.", 404);
  return { payload: qrPayload(ticket.id, ticket.secret), checkedInAt: ticket.checkedInAt };
}

/**
 * Staff scans a ticket's code at the door: checks it, records the check-in and
 * mints the attendee's event stamp (+100 XP on their Estela Pass).
 */
export async function checkIn(staff: Session, payload: string) {
  const parsed = parseQr(payload);
  if (!parsed) throw new BookingError("Este código no es un ticket de Estela.");

  const database = db();
  const [row] = await database
    .select({ ticket: tickets, event: events, booking: bookings, attendee: users })
    .from(tickets)
    .innerJoin(events, eq(tickets.eventId, events.id))
    .innerJoin(bookings, eq(tickets.bookingId, bookings.id))
    .innerJoin(users, eq(tickets.userId, users.id))
    .where(eq(tickets.id, parsed.ticketId));
  if (!row) throw new BookingError("No encontramos ese ticket.", 404);
  const { ticket, event, booking, attendee } = row;

  // Organizers can only check people into their own events.
  if (staff.role === "organizer") {
    const own =
      event.organizerId !== null &&
      (await database
        .select({ id: organizers.id })
        .from(organizers)
        .where(and(eq(organizers.userId, staff.userId), eq(organizers.id, event.organizerId)))).length > 0;
    if (!own) throw new BookingError("Este ticket es de un evento de otro organizador.", 403);
  }

  if (!verifyQr(payload, ticket.qrSecret)) {
    throw new BookingError("Código vencido o inválido: pide que muestren el QR otra vez.", 400);
  }
  if (booking.status !== "confirmed") throw new BookingError("La reserva de este ticket no está confirmada.", 409);
  if (ticket.checkedInAt) {
    throw new BookingError(`Este ticket ya hizo check-in (${ticket.checkedInAt.toLocaleString("es-ES")}).`, 409);
  }

  // One event stamp per person and event, even if they hold several tickets.
  const [existingStamp] = await database
    .select({ tokenId: stamps.tokenId })
    .from(stamps)
    .where(and(eq(stamps.userId, attendee.id), eq(stamps.kind, "event"), eq(stamps.refId, event.id)));

  let stamp: { tokenId: number; txHash: string } | null = null;
  if (!existingStamp) {
    const txHash = await chain.mintStamp(attendee.wallet, "Event", BigInt(event.id));
    const tokenId = await chain.stampOf(attendee.wallet, "Event", BigInt(event.id));
    if (tokenId === null) throw new chain.ChainError("stamp minted but not found on-chain");
    await database
      .insert(stamps)
      .values({ tokenId, userId: attendee.id, kind: "event", refId: event.id, txHash })
      .onConflictDoNothing();
    stamp = { tokenId, txHash };
  }

  await database
    .update(tickets)
    .set({ checkedInAt: new Date(), checkedInBy: staff.userId })
    .where(eq(tickets.id, ticket.id));

  return {
    ticketId: ticket.id,
    event: event.title,
    attendee: attendee.wallet,
    stamp,
    alreadyStamped: Boolean(existingStamp),
  };
}
