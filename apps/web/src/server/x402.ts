import "server-only";
import {
  type HTTPAdapter,
  HTTPFacilitatorClient,
  type RouteConfig,
  SETTLEMENT_OVERRIDES_HEADER,
  withPrivateCacheControl,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "./env";

// Pay-per-request API access for AI agents (x402). An agent calls an endpoint, gets
// 402 with the price, signs a USDC transfer (Soroban auth entries only; the
// facilitator pays the network fee) and repeats the call with the payment header.
// Settlement happens only if our handler succeeded (status < 400), so agents never
// pay for errors.
//
// This mirrors @x402/next's withX402, which requires Next 16; this app is on 15.

let resourceServer: x402ResourceServer | undefined;

function server() {
  resourceServer ??= new x402ResourceServer(new HTTPFacilitatorClient({ url: env().X402_FACILITATOR_URL })).register(
    env().X402_NETWORK,
    new ExactStellarScheme(),
  );
  return resourceServer;
}

/** A USDC price for one call, paid to Estela's treasury. */
export function agentPrice(price: string, description: string): RouteConfig {
  return {
    accepts: { scheme: "exact", price, network: env().X402_NETWORK, payTo: env().X402_PAY_TO, maxTimeoutSeconds: 120 },
    description,
    mimeType: "application/json",
  };
}

class NextAdapter implements HTTPAdapter {
  constructor(private readonly req: NextRequest) {}
  getHeader = (name: string) => this.req.headers.get(name) ?? undefined;
  getMethod = () => this.req.method;
  getPath = () => this.req.nextUrl.pathname;
  getUrl = () => this.req.url;
  getAcceptHeader = () => this.req.headers.get("Accept") ?? "";
  getUserAgent = () => this.req.headers.get("User-Agent") ?? "";
  getQueryParams = () => Object.fromEntries(this.req.nextUrl.searchParams.entries());
  getQueryParam = (name: string) => this.req.nextUrl.searchParams.get(name) ?? undefined;
  getBody = async () => this.req.clone().json().catch(() => undefined);
}

function jsonResponse(body: unknown, status: number, init?: HeadersInit) {
  const headers = new Headers(init);
  headers.set("Content-Type", "application/json");
  return new NextResponse(JSON.stringify(body ?? {}), { status, headers });
}

/** Wraps a route handler so each successful call costs `route`'s price. */
export function withAgentPayment(handler: (req: NextRequest) => Promise<Response>, route: RouteConfig) {
  let http: x402HTTPResourceServer | undefined;
  let ready: Promise<void> | undefined;

  return async (req: NextRequest): Promise<Response> => {
    if (!http) http = new x402HTTPResourceServer(server(), route);
    ready ??= http.initialize().catch((err) => {
      ready = undefined; // retry on the next call
      throw err;
    });
    try {
      await ready;
    } catch (err) {
      console.error("[x402] facilitator unavailable", err);
      return jsonResponse({ error: "El servicio de pagos para agentes no está disponible. Inténtalo más tarde." }, 503);
    }

    const adapter = new NextAdapter(req);
    const context = {
      adapter,
      path: req.nextUrl.pathname,
      method: req.method,
      paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
    };
    const result = await http.processHTTPRequest(context);

    if (result.type === "no-payment-required") return handler(req);
    if (result.type === "payment-error") {
      const r = result.response;
      return r.isHtml
        ? new NextResponse(r.body as string, { status: r.status, headers: r.headers })
        : jsonResponse(r.body, r.status, r.headers);
    }

    // Payment verified: run the handler, then settle only if it succeeded.
    let response: Response;
    try {
      response = await handler(req);
    } catch (err) {
      await result.cancellationDispatcher.cancel({ reason: "handler_threw", error: err });
      console.error(err);
      return jsonResponse({ error: "Algo salió mal. No se te cobró." }, 500);
    }
    if (response.status >= 400) {
      await result.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: response.status });
      return response;
    }

    const body = Buffer.from(await response.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => (responseHeaders[k] = v));
    const settled = await http.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      { request: context, responseBody: body, responseHeaders },
      undefined,
      result.beforeHandlerSettlement,
    );
    if (!settled.success) {
      const r = settled.response;
      return jsonResponse(r.isHtml ? { error: "No se pudo cobrar el pago." } : r.body, r.status, r.headers);
    }
    const out = new NextResponse(body, { status: response.status, headers: response.headers });
    out.headers.delete("transfer-encoding");
    out.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
    for (const [k, v] of Object.entries(settled.headers)) out.headers.set(k, v);
    out.headers.set("Cache-Control", withPrivateCacheControl(out.headers.get("Cache-Control")));
    return out;
  };
}
