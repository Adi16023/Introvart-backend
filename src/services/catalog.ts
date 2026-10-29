import type { Artist, Artwork } from "@prisma/client";
import { prisma } from "../lib/db";
import { fromPrice, loadConfig, type PricingConfig } from "./pricing";
import { productInclude } from "./products";
import type { ProductVariant, ProductImage } from "@prisma/client";
import { variantAvailable } from "./product-variants";

function edit(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1 || a.length > 12) return 2;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = temp;
    }
  }
  return row[b.length];
}

export function matches(query: string, artwork: Artwork, artistName: string) {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const hay = [artwork.title, artwork.story, artwork.category, artwork.style, artistName, ...artwork.tags, ...artwork.colours, ...artwork.rooms, ...artwork.occasions]
    .join(" ")
    .toLowerCase();
  if (hay.includes(q)) return true;
  const tokens = hay.split(/\W+/);
  return q.split(/\s+/).every((word) => tokens.some((token) => token.startsWith(word.slice(0, 4)) || edit(token, word) <= 1));
}

type ArtistCard = Pick<Artist, "id" | "slug" | "name" | "city" | "verified" | "boostedUntil">;
export type ArtworkWithArtist = Artwork & { artist: ArtistCard; variants?: ProductVariant[]; images?: ProductImage[] };

export function present(config: PricingConfig, artwork: ArtworkWithArtist) {
  const { boostedUntil: _boost, ...artist } = artwork.artist;
  const { sourceRows: _source, ...product } = artwork;
  return { ...product, artist, fromPrice: fromPrice(config, artwork) };
}

export type CatalogQuery = {
  q?: string;
  mode?: "all" | "original" | "collection" | "occasion" | "colour" | "room";
  value?: string;
  colour?: string;
  room?: string;
  inStock?: boolean;
  sort?: "featured" | "price-asc" | "price-desc" | "rating" | "newest";
  fulfilment?: string;
  artist?: string;
  page: number;
  limit: number;
};

const artistSelect = { select: { id: true, slug: true, name: true, city: true, verified: true, boostedUntil: true } } as const;

export async function listArtworks(query: CatalogQuery) {
  const config = await loadConfig();
  const mode = query.mode ?? "all";
  let ids: string[] | null = null;
  if (mode === "collection") {
    const collection = await prisma.collection.findUnique({ where: { slug: query.value ?? "" } });
    ids = collection?.ids ?? [];
  }

  const rows = await prisma.artwork.findMany({
    where: {
      status: "approved",
      artist: { suspended: false, ...(query.artist ? { slug: query.artist } : {}) },
      ...(mode === "original" ? { fulfilment: "original" } : query.fulfilment ? { fulfilment: query.fulfilment } : { fulfilment: { not: "commission" } }),
      ...(ids ? { id: { in: ids } } : {}),
    },
    include: { artist: artistSelect, ...productInclude },
    orderBy: { createdAt: "asc" },
  });

  const value = (query.value ?? "").toLowerCase();
  let list = rows as ArtworkWithArtist[];
  if (mode === "occasion") list = list.filter((a) => a.occasions.some((x) => x.toLowerCase() === value));
  if (mode === "colour") list = list.filter((a) => a.colours.some((x) => x.toLowerCase() === value));
  if (mode === "room") list = list.filter((a) => a.rooms.some((x) => x.toLowerCase().replace(/\s+/g, "-") === value));
  if (query.colour) list = list.filter((a) => a.colours.includes(query.colour!));
  if (query.room) list = list.filter((a) => a.rooms.includes(query.room!));
  if (query.inStock) list = list.filter((a) => a.variants?.length ? a.variants.some((variant) => variantAvailable(variant)) : a.stock === null || a.stock > 0);
  if (query.q?.trim()) list = list.filter((a) => matches(query.q!, a, a.artist.name));

  const price = (a: ArtworkWithArtist) => fromPrice(config, a);
  if (query.sort === "price-asc") list = [...list].sort((a, b) => price(a) - price(b));
  else if (query.sort === "price-desc") list = [...list].sort((a, b) => price(b) - price(a));
  else if (query.sort === "rating") list = [...list].sort((a, b) => b.rating - a.rating);
  else if (query.sort === "newest") list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  else {
    // Featured: studios with an approved, running boost come first.
    const boosted = (a: ArtworkWithArtist) => (a.artist.boostedUntil && a.artist.boostedUntil.getTime() > Date.now() ? 1 : 0);
    list = [...list].sort((a, b) => boosted(b) - boosted(a));
  }

  const total = list.length;
  const start = (query.page - 1) * query.limit;
  return {
    total,
    page: query.page,
    limit: query.limit,
    items: list.slice(start, start + query.limit).map((a) => present(config, a)),
  };
}

export async function artworksByIds(ids: string[]) {
  if (!ids.length) return [];
  const config = await loadConfig();
  const rows = await prisma.artwork.findMany({
    where: { id: { in: ids } },
    include: { artist: artistSelect, ...productInclude },
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  return (rows as ArtworkWithArtist[])
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((a) => present(config, a));
}
