import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { canonicalMediaUrl } from "../lib/storage";
import { loadAnnouncement } from "./announcement";
import { loadMenu } from "./menu";
import { fromPrice, loadConfig, type PricingConfig } from "./pricing";
import { productImageSchema } from "./products";
import { loadSearchSettings } from "./searchSettings";
import { loadPaymentSettings } from "./paymentSettings";
import { cashfreeConfigured } from "./cashfree";

const cardSelect = {
  id: true, slug: true, title: true, image: true, images: true,
  fulfilment: true, basePrice: true, priceFactor: true, stock: true,
  rating: true, reviewCount: true,
  artist: { select: { id: true, name: true } },
  variants: { select: { price: true }, orderBy: { price: "asc" }, take: 1 },
} satisfies Prisma.ProductSelect;

const visibleProducts = { status: "approved", fulfilment: { not: "commission" }, artist: { suspended: false } } satisfies Prisma.ProductWhereInput;

function card(config: PricingConfig, product: Prisma.ProductGetPayload<{ select: typeof cardSelect }>) {
  const { variants: _variants, basePrice: _base, priceFactor: _factor, images, ...summary } = product;
  return {
    ...summary,
    images: productImageSchema.array().parse(images).slice(0, 2),
    fromPrice: fromPrice(config, product),
  };
}

async function buildStorefrontHome() {
  const [settings, banners, collections, occasions, artists, trending, newest, menu, announcement, searchSettings, payments] = await Promise.all([
    loadConfig(),
    prisma.banner.findMany({ where: { active: true }, orderBy: { sort: "asc" }, take: 3 }),
    prisma.collection.findMany({ orderBy: { sort: "asc" }, select: { slug: true, title: true, lede: true, image: true, menuPlacement: true, createdAt: true } }),
    prisma.occasion.findMany({ orderBy: { sort: "asc" } }),
    prisma.artist.findMany({
      where: { verified: true, suspended: false }, orderBy: { name: "asc" }, take: 6,
      select: { id: true, slug: true, name: true, city: true, portrait: true },
    }),
    prisma.product.findMany({ where: visibleProducts, orderBy: [{ reviewCount: "desc" }, { id: "asc" }], take: 8, select: cardSelect }),
    prisma.product.findMany({ where: visibleProducts, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 8, select: cardSelect }),
    loadMenu(),
    loadAnnouncement(),
    loadSearchSettings(),
    loadPaymentSettings(),
  ]);
  const rooms = settings.rooms.slice(0, 6);
  const roomRows = rooms.length ? await prisma.$queryRaw<{ name: string; count: number; image: string }[]>(Prisma.sql`
    SELECT room.name, COUNT(DISTINCT p.id)::integer AS count,
      MIN(COALESCE(NULLIF(p."roomImage", ''), p.image)) AS image
    FROM "Products" p
    JOIN "Artist" a ON a.id = p."artistId"
    CROSS JOIN LATERAL unnest(p.rooms) AS room(name)
    WHERE p.status = 'approved' AND p.fulfilment <> 'commission' AND NOT a.suspended
      AND room.name IN (${Prisma.join(rooms)})
    GROUP BY room.name
  `) : [];
  const { capacity: _capacity, holidays: _holidays, colours, rooms: allRooms, partnerName, ...config } = settings;
  return {
    config: { ...config, codEnabled: payments.codEnabled, onlinePayments: cashfreeConfigured() },
    colours, rooms: allRooms, partnerName,
    banners,
    collections: collections.map((item) => ({ ...item, image: canonicalMediaUrl(item.image) })),
    occasions,
    artists,
    trending: trending.map((product) => card(config, product)),
    newest: newest.map((product) => card(config, product)),
    roomHighlights: rooms.map((name) => roomRows.find((room) => room.name === name) ?? { name, count: 0, image: "" }),
    menu, announcement, searchSettings,
  };
}

const CACHE_MS = 60_000;
let cached: { data: Awaited<ReturnType<typeof buildStorefrontHome>>; expiresAt: number } | undefined;
let pending: Promise<Awaited<ReturnType<typeof buildStorefrontHome>>> | undefined;

export async function loadStorefrontHome() {
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (!pending) {
    pending = buildStorefrontHome().then((data) => {
      cached = { data, expiresAt: Date.now() + CACHE_MS };
      return data;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}

export async function loadStorefrontSession(ownerId: string, customerId?: string) {
  const [customer, cart, wishlist, follows, recent, searches] = await Promise.all([
    customerId ? prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, email: true, phone: true, city: true, risk: true, credit: true, referral: true },
    }) : null,
    prisma.cartItem.aggregate({ where: { ownerId }, _sum: { quantity: true } }),
    prisma.wishlistItem.findMany({ where: { ownerId }, select: { productId: true }, orderBy: { createdAt: "desc" } }),
    prisma.follow.findMany({ where: { ownerId }, select: { artistId: true } }),
    prisma.recentView.findMany({ where: { ownerId }, select: { productId: true }, orderBy: { at: "desc" }, take: 8 }),
    prisma.searchHistory.findMany({ where: { ownerId }, select: { query: true }, orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  const ids = recent.map((item) => item.productId);
  const [config, products] = ids.length ? await Promise.all([
    loadConfig(),
    prisma.product.findMany({ where: { ...visibleProducts, id: { in: ids } }, select: cardSelect }),
  ]) : [null, []];
  return {
    customer, cartCount: cart._sum.quantity ?? 0,
    wishlist: wishlist.map((item) => item.productId),
    follows: follows.map((item) => item.artistId),
    recent: config ? ids.flatMap((id) => {
      const product = products.find((item) => item.id === id);
      return product ? [card(config, product)] : [];
    }) : [],
    recentSearches: [...new Set(searches.map((item) => item.query))].slice(0, 6),
  };
}
