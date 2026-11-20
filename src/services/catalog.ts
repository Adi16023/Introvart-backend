import type { Artist, Product } from "@prisma/client";
import { prisma } from "../lib/db";
import { fromPrice, loadConfig, type PricingConfig } from "./pricing";
import { productImageSchema, productInclude } from "./products";
import type { ProductVariant } from "@prisma/client";
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

export function matches(query: string, product: Product, artistName: string) {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const hay = [product.title, product.story, product.category, product.style, artistName, ...product.tags, ...product.colours, ...product.rooms, ...product.occasions]
    .join(" ")
    .toLowerCase();
  if (hay.includes(q)) return true;
  const tokens = hay.split(/\W+/);
  return q.split(/\s+/).every((word) => tokens.some((token) => token.startsWith(word.slice(0, 4)) || edit(token, word) <= 1));
}

type ArtistCard = Pick<Artist, "id" | "slug" | "name" | "city" | "verified" | "boostedUntil">;
export type ProductWithArtist = Product & { artist: ArtistCard; variants?: ProductVariant[] };

export function present(config: PricingConfig, product: ProductWithArtist) {
  const { boostedUntil: _boost, ...artist } = product.artist;
  const { sourceRows: _source, ...publicProduct } = product;
  const images = productImageSchema.array().parse(product.images);
  return { ...publicProduct, images, artist, fromPrice: fromPrice(config, product) };
}

export type CatalogQuery = {
  q?: string;
  mode?: "all" | "original" | "collection" | "occasion" | "colour" | "room";
  value?: string;
  colour?: string;
  colours?: string;
  room?: string;
  inStock?: boolean;
  availability?: string;
  sort?: "featured" | "price-asc" | "price-desc" | "rating" | "newest";
  fulfilment?: string;
  artist?: string;
  artists?: string;
  sizes?: string;
  minPrice?: number;
  maxPrice?: number;
  page: number;
  limit: number;
};

function csv(value?: string) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function productInStock(product: ProductWithArtist) {
  return product.variants?.length
    ? product.variants.some((variant) => variantAvailable(variant))
    : product.stock === null || product.stock > 0;
}

const artistSelect = { select: { id: true, slug: true, name: true, city: true, verified: true, boostedUntil: true } } as const;

export async function listProducts(query: CatalogQuery) {
  const config = await loadConfig();
  const mode = query.mode ?? "all";
  let ids: string[] | null = null;
  if (mode === "collection") {
    const collection = await prisma.collection.findUnique({ where: { slug: query.value ?? "" } });
    ids = collection?.ids ?? [];
  }

  const artistSlugs = [...new Set([...csv(query.artists), ...(query.artist ? [query.artist] : [])])];
  const rows = await prisma.product.findMany({
    where: {
      status: "approved",
      artist: {
        suspended: false,
        ...(artistSlugs.length === 1 ? { slug: artistSlugs[0] } : artistSlugs.length > 1 ? { slug: { in: artistSlugs } } : {}),
      },
      ...(mode === "original" ? { fulfilment: "original" } : query.fulfilment ? { fulfilment: query.fulfilment } : { fulfilment: { not: "commission" } }),
      ...(ids ? { id: { in: ids } } : {}),
    },
    include: { artist: artistSelect, ...productInclude },
    orderBy: { createdAt: "asc" },
  });

  const value = (query.value ?? "").toLowerCase();
  let list = rows;
  if (mode === "occasion") list = list.filter((a) => a.occasions.some((x) => x.toLowerCase() === value));
  if (mode === "colour") list = list.filter((a) => a.colours.some((x) => x.toLowerCase() === value));
  if (mode === "room") list = list.filter((a) => a.rooms.some((x) => x.toLowerCase().replace(/\s+/g, "-") === value));
  const colours = [...new Set([...csv(query.colours), ...(query.colour ? [query.colour] : [])])];
  if (colours.length) list = list.filter((a) => a.colours.some((colour) => colours.includes(colour)));
  if (query.room) list = list.filter((a) => a.rooms.includes(query.room!));

  const availability = new Set(csv(query.availability).map((entry) => entry.toLowerCase()));
  const wantIn = availability.has("in") || availability.has("in-stock") || availability.has("instock");
  const wantOut = availability.has("out") || availability.has("out-of-stock") || availability.has("outofstock");
  if (wantIn !== wantOut) {
    list = list.filter((a) => (wantIn ? productInStock(a) : !productInStock(a)));
  } else if (query.inStock) {
    list = list.filter((a) => productInStock(a));
  }

  const sizeTokens = new Set(csv(query.sizes).map((entry) => entry.toLowerCase()));
  if (sizeTokens.size) {
    for (const size of config.sizes) {
      if (sizeTokens.has(size.id.toLowerCase()) || sizeTokens.has(size.label.toLowerCase())) {
        sizeTokens.add(size.id.toLowerCase());
        sizeTokens.add(size.label.toLowerCase());
        if (size.cm) sizeTokens.add(size.cm.toLowerCase());
      }
    }
    list = list.filter((product) => {
      if (!product.variants?.length) return product.fulfilment === "original" && sizeTokens.has("original");
      return product.variants.some((variant) => variant.optionValues.some((option) => sizeTokens.has(option.toLowerCase())));
    });
  }

  if (query.q?.trim()) list = list.filter((a) => matches(query.q!, a, a.artist.name));

  const price = (a: ProductWithArtist) => fromPrice(config, a);
  if (query.minPrice != null || query.maxPrice != null) {
    list = list.filter((a) => {
      const amount = price(a);
      if (query.minPrice != null && amount < query.minPrice) return false;
      if (query.maxPrice != null && amount > query.maxPrice) return false;
      return true;
    });
  }
  if (query.sort === "price-asc") list = [...list].sort((a, b) => price(a) - price(b));
  else if (query.sort === "price-desc") list = [...list].sort((a, b) => price(b) - price(a));
  else if (query.sort === "rating") list = [...list].sort((a, b) => b.rating - a.rating);
  else if (query.sort === "newest") list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  else {
    // Featured: studios with an approved, running boost come first.
    const boosted = (a: ProductWithArtist) => (a.artist.boostedUntil && a.artist.boostedUntil.getTime() > Date.now() ? 1 : 0);
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

export async function productsByIds(ids: string[]) {
  if (!ids.length) return [];
  const config = await loadConfig();
  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: { artist: artistSelect, ...productInclude },
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((a) => present(config, a));
}
