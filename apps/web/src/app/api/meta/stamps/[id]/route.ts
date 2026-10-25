import { errorResponse, json } from "@/server/http";
import { stampMetadata } from "@/server/nft";
import { stampArt, tokenIdParam } from "@/server/nft-data";

/** NFT metadata for stamp #id: what EstelaStamps' `token_uri` points to. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = tokenIdParam((await params).id);
  if (id === null) return json({ error: "invalid token id" }, { status: 400 });
  try {
    const art = await stampArt(id);
    if (!art) return json({ error: "no such stamp" }, { status: 404 });
    const image = new URL(`/api/meta/stamps/${id}/image`, req.url).toString();
    // A stamp never changes (only revocation removes it), so it can be cached longer.
    return json(stampMetadata({ ...art, image }), { headers: { "Cache-Control": "public, max-age=3600" } });
  } catch (err) {
    return errorResponse(err);
  }
}
