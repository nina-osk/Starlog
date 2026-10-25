// Passenger checks done before the traveler pays: airlines only validate these when
// the flight is ordered, which happens after payment and would force a refund.

export class PassengerError extends Error {}

const ADULT_AGE = 18;

/** Adult fares need a passenger born in the past and aged 18+ on the day they fly. */
export function assertAdultOnFlight(bornOn: string, departingAt: string, today = new Date()): void {
  const born = new Date(`${bornOn}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) throw new PassengerError("La fecha de nacimiento no es válida.");
  if (born >= today) {
    throw new PassengerError("La fecha de nacimiento no puede ser hoy ni una fecha futura. ¿Pusiste la fecha del viaje?");
  }
  const flight = new Date(departingAt.slice(0, 10) + "T00:00:00Z");
  const eighteenth = new Date(born);
  eighteenth.setUTCFullYear(born.getUTCFullYear() + ADULT_AGE);
  if (eighteenth > flight) {
    throw new PassengerError("Por ahora solo vendemos vuelos a mayores de 18 años (en la fecha del vuelo).");
  }
  if (born.getUTCFullYear() < 1900) throw new PassengerError("Revisa la fecha de nacimiento.");
}
