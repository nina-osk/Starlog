"use client";

import { useEffect, useState } from "react";

type Stamp = { tokenId: number; kind: "event" | "trip"; refId: number; createdAt: string };

/** The member's soulbound stamps (events attended, trips completed). */
export function MyStamps({ refreshKey }: { refreshKey: number }) {
  const [stamps, setStamps] = useState<Stamp[] | null>(null);

  useEffect(() => {
    fetch("/api/me/stamps")
      .then((res) => (res.ok ? res.json() : []))
      .then(setStamps);
  }, [refreshKey]);

  if (!stamps || stamps.length === 0) return null;

  return (
    <section className="w-full max-w-xl flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Mis sellos</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {stamps.map((s) => (
          <a
            key={s.tokenId}
            href={`/api/meta/stamps/${s.tokenId}`}
            target="_blank"
            rel="noreferrer"
            title="Ver metadatos del NFT"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- dynamic SVG from our API */}
            <img
              src={`/api/meta/stamps/${s.tokenId}/image`}
              alt={s.kind === "event" ? "Sello de evento" : "Sello de viaje"}
              width={300}
              height={300}
              className="w-full h-auto rounded-xl border border-black/10 dark:border-white/15"
            />
          </a>
        ))}
      </div>
    </section>
  );
}
