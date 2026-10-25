import { describe, expect, it } from "vitest";
import { assertAdultOnFlight, PassengerError } from "./passenger";

const today = new Date("2026-10-25T12:00:00Z");
const flight = "2026-11-23T17:01:00";

describe("assertAdultOnFlight", () => {
  it("accepts an adult", () => {
    expect(() => assertAdultOnFlight("1990-05-14", flight, today)).not.toThrow();
  });

  it("rejects the travel date typed as the birth date (the real-world mistake)", () => {
    expect(() => assertAdultOnFlight("2026-11-23", flight, today)).toThrow(/fecha del viaje/);
  });

  it("rejects today", () => {
    expect(() => assertAdultOnFlight("2026-10-25", flight, today)).toThrow(PassengerError);
  });

  it("counts age on the day of the flight", () => {
    expect(() => assertAdultOnFlight("2008-11-23", flight, today)).not.toThrow(); // turns 18 that day
    expect(() => assertAdultOnFlight("2008-11-24", flight, today)).toThrow(/mayores de 18/);
  });

  it("rejects nonsense dates", () => {
    expect(() => assertAdultOnFlight("1850-01-01", flight, today)).toThrow(PassengerError);
    expect(() => assertAdultOnFlight("1990-13-45", flight, today)).toThrow(PassengerError);
  });
});
