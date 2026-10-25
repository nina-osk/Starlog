// Artwork and metadata for Estela's NFTs. Images are SVG drawn from on-chain state,
// so the pass changes look as the member levels up without re-minting anything.

export type Level = "Explorer" | "Voyager" | "Globetrotter" | "Legend";

const LEVELS: Record<Level, { colors: [string, string]; next: number | null; discount: number }> = {
  Explorer: { colors: ["#64748b", "#334155"], next: 500, discount: 0 },
  Voyager: { colors: ["#0ea5e9", "#1d4ed8"], next: 2_000, discount: 5 },
  Globetrotter: { colors: ["#a855f7", "#6d28d9"], next: 5_000, discount: 10 },
  Legend: { colors: ["#f59e0b", "#b45309"], next: null, discount: 15 },
};

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export function passSvg({ tokenId, level, xp }: { tokenId: number; level: Level; xp: number }): string {
  const { colors, next } = LEVELS[level];
  const progress = next === null ? 1 : Math.min(xp / next, 1);
  const footer = next === null ? `${xp} XP · nivel máximo` : `${xp} / ${next} XP`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" viewBox="0 0 400 250">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
<rect width="400" height="250" rx="20" fill="url(#g)"/>
<path d="M330 40l6 18 19 1-15 11 5 18-15-10-15 10 5-18-15-11 19-1z" fill="#fff" fill-opacity=".85"/>
<text x="28" y="52" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#fff" fill-opacity=".8">ESTELA PASS #${tokenId}</text>
<text x="28" y="120" font-family="Helvetica,Arial,sans-serif" font-size="40" font-weight="700" fill="#fff">${escape(level)}</text>
<rect x="28" y="176" width="344" height="10" rx="5" fill="#fff" fill-opacity=".25"/>
<rect x="28" y="176" width="${Math.round(344 * progress)}" height="10" rx="5" fill="#fff"/>
<text x="28" y="216" font-family="Helvetica,Arial,sans-serif" font-size="15" fill="#fff">${escape(footer)}</text>
</svg>`;
}

export function passMetadata({ tokenId, level, xp, image }: { tokenId: number; level: Level; xp: number; image: string }) {
  return {
    name: `Estela Pass #${tokenId}`,
    description: `Membresía de Estela, intransferible. Nivel ${level}: ${LEVELS[level].discount}% de descuento en reservas.`,
    image,
    attributes: [
      { trait_type: "Level", value: level },
      { trait_type: "XP", value: xp, display_type: "number" },
      { trait_type: "Discount", value: LEVELS[level].discount, display_type: "boost_percentage" },
    ],
  };
}

export type StampArt = { tokenId: number; kind: "Event" | "Trip"; title: string; place: string; date: string };

export function stampSvg({ tokenId, kind, title, place, date }: StampArt): string {
  const color = kind === "Event" ? "#0f766e" : "#9d174d";
  // Long titles are split over two lines (the stamp is round, so lines stay short).
  const words = title.split(/\s+/);
  const lines: string[] = [""];
  for (const w of words) {
    if ((lines[lines.length - 1] + " " + w).trim().length > 18 && lines.length < 2) lines.push(w);
    else lines[lines.length - 1] = (lines[lines.length - 1] + " " + w).trim();
  }
  const text = lines
    .map((l, i) => `<text x="150" y="${138 + i * 26}" text-anchor="middle" font-size="22" font-weight="700" fill="${color}">${escape(l.length > 22 ? `${l.slice(0, 21)}…` : l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300" font-family="Helvetica,Arial,sans-serif">
<rect width="300" height="300" fill="#fffdf7"/>
<circle cx="150" cy="150" r="130" fill="none" stroke="${color}" stroke-width="6"/>
<circle cx="150" cy="150" r="116" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6 6"/>
<text x="150" y="82" text-anchor="middle" font-size="14" letter-spacing="3" fill="${color}">${kind === "Event" ? "ESTUVE AHÍ" : "VIAJE COMPLETADO"}</text>
${text}
<text x="150" y="204" text-anchor="middle" font-size="14" fill="${color}">${escape(place)}</text>
<text x="150" y="226" text-anchor="middle" font-size="13" fill="${color}" fill-opacity=".8">${escape(date)}</text>
<text x="150" y="258" text-anchor="middle" font-size="11" fill="${color}" fill-opacity=".7">ESTELA #${tokenId}</text>
</svg>`;
}

export function stampMetadata(art: StampArt & { image: string }) {
  return {
    name: `${art.kind === "Event" ? "Sello" : "Viaje"}: ${art.title}`,
    description:
      art.kind === "Event"
        ? `Prueba de asistencia a ${art.title} (${art.place}, ${art.date}). Intransferible.`
        : `Viaje completado con Estela: ${art.title}. Intransferible.`,
    image: art.image,
    attributes: [
      { trait_type: "Kind", value: art.kind },
      { trait_type: "Place", value: art.place },
      { trait_type: "Date", value: art.date },
    ],
  };
}
