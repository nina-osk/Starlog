import { errorResponse, json } from "@/server/http";
import { stampSvg } from "@/server/nft";
import { stampArt, tokenIdParam } from "@/server/nft-data";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = tokenIdParam((await params).id);
  if (id === null) return json({ error: "Token no válido." }, { status: 400 });
  try {
    const art = await stampArt(id);
    if (!art) return json({ error: "Ese sello no existe." }, { status: 404 });
    return new Response(stampSvg(art), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
