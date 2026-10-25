import { describe, expect, it } from "vitest";
import { passMetadata, passSvg, stampMetadata, stampSvg } from "./nft";

describe("Estela Pass art", () => {
  it("shows level, token and progress to the next level", () => {
    const svg = passSvg({ tokenId: 3, level: "Voyager", xp: 1_000 });
    expect(svg).toContain("ESTELA PASS #3");
    expect(svg).toContain("Voyager");
    expect(svg).toContain("1000 / 2000 XP");
    expect(svg).toContain('width="172"'); // half of the 344 px bar
  });

  it("fills the bar at the top level", () => {
    const svg = passSvg({ tokenId: 1, level: "Legend", xp: 9_000 });
    expect(svg).toContain("nivel máximo");
    expect(svg).toContain('width="344"');
  });

  it("describes the discount in the metadata", () => {
    const meta = passMetadata({ tokenId: 1, level: "Globetrotter", xp: 2_500, image: "https://x/img" });
    expect(meta.name).toBe("Estela Pass #1");
    expect(meta.attributes).toContainEqual({ trait_type: "Discount", value: 10, display_type: "boost_percentage" });
  });
});

describe("stamp art", () => {
  const art = { tokenId: 7, kind: "Event" as const, title: "Stellar Builders Night Madrid", place: "Madrid", date: "24 nov 2026" };

  it("wraps long titles and labels the kind", () => {
    const svg = stampSvg(art);
    expect(svg).toContain("ESTUVE AHÍ");
    expect(svg).toContain(">Stellar Builders<");
    expect(svg).toContain(">Night Madrid<");
    expect(svg).toContain("ESTELA #7");
  });

  it("escapes text that came from organizers", () => {
    const svg = stampSvg({ ...art, title: '<script>alert("x")</script> & co' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("produces metadata for trips too", () => {
    expect(stampMetadata({ ...art, kind: "Trip", image: "i" }).name).toBe("Viaje: Stellar Builders Night Madrid");
  });
});
