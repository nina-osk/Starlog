import { errorResponse, json } from "@/server/http";
import { passSvg } from "@/server/nft";
import { passArt, tokenIdParam } from "@/server/nft-data";

/** The pass card, drawn from the holder's current level and XP. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = tokenIdParam((await params).id);
  if (id === null) return json({ error: "invalid token id" }, { status: 400 });
  try {
    const art = await passArt(id);
    if (!art) return json({ error: "no such pass" }, { status: 404 });
    return new Response(passSvg(art), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
