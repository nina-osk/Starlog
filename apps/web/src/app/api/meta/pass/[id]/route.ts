import { errorResponse, json } from "@/server/http";
import { passMetadata } from "@/server/nft";
import { passArt, tokenIdParam } from "@/server/nft-data";

/** NFT metadata for Estela Pass #id: what `token_uri` points to (base URI + id). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = tokenIdParam((await params).id);
  if (id === null) return json({ error: "invalid token id" }, { status: 400 });
  try {
    const art = await passArt(id);
    if (!art) return json({ error: "no such pass" }, { status: 404 });
    const image = new URL(`/api/meta/pass/${id}/image`, req.url).toString();
    return json(passMetadata({ ...art, image }), { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (err) {
    return errorResponse(err);
  }
}
