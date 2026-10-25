import { describe, expect, it } from "vitest";
import { payErrorMessage } from "./bookings";

describe("payErrorMessage", () => {
  it("explains a lack of funds as such", () => {
    expect(payErrorMessage({ status: "error", details: "tx_failed: op_underfunded" })).toBe("Saldo insuficiente en tu wallet.");
    expect(payErrorMessage({ status: "error", details: "HostError: Error(Contract, #10)" })).toBe("Saldo insuficiente en tu wallet.");
  });

  it("recognizes a payment the user cancelled", () => {
    expect(payErrorMessage({ status: "error", code: "SDK_CONFIRMATION_DECLINED" })).toBe("Cancelaste el pago.");
  });

  it("falls back to a generic message without leaking codes", () => {
    const msg = payErrorMessage({ status: "error", code: "SDK_SOMETHING_ODD" });
    expect(msg).toBe("No se pudo enviar el pago desde tu wallet. Inténtalo de nuevo.");
  });
});
