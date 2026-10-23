import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { notFound, param, parse, uid } from "../lib/http";
import { artworksByIds, listArtworks, matches, present, type ArtworkWithArtist } from "../services/catalog";
import { balanceOf, issueGiftCard } from "../services/giftcards";
import { fromPrice, loadConfig, pincodeInfo, unitPrice } from "../services/pricing";

export const publicRouter = Router();

const bool = z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean());

const catalogQuery = z.object({
  q: z.string().optional(),
  mode: z.enum(["all", "original", "collection", "occasion", "colour", "room"]).optional(),
  value: z.string().optional(),
  colour: z.string().optional(),
  room: z.string().optional(),
  inStock: bool.optional(),
  sort: z.enum(["featured", "price-asc", "price-desc", "rating", "newest"]).optional(),
  fulfilment: z.string().optional(),
  artist: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(48),
});

const artistSelect = { select: { id: true, slug: true, name: true, city: true, verified: true, boostedUntil: true } } as const;

// Public artist payload: no KYC, bank, PAN or contact details.
const publicArtist = (artist: {
  id: string; slug: string; name: string; city: string; bio: string; cover: string; portrait: string; verified: boolean;
  styles: string[]; social: string; commissionEnabled: boolean; mediums: string[]; priceFrom: number; turnaround: string; slots: number;
}) => ({
  id: artist.id, slug: artist.slug, name: artist.name, city: artist.city, bio: artist.bio, cover: artist.cover, portrait: artist.portrait,
  verified: artist.verified, styles: artist.styles, social: artist.social, commissionEnabled: artist.commissionEnabled,
  mediums: artist.mediums, priceFrom: artist.priceFrom, turnaround: artist.turnaround, slots: artist.slots,
});

publicRouter.get("/config", async (_req, res) => {
  const config = await loadConfig();
  const { capacity: _c, holidays: _h, ...rest } = config;
  res.json(rest);
});

publicRouter.get("/banners", async (_req, res) => {
  res.json(await prisma.banner.findMany({ where: { active: true }, orderBy: { sort: "asc" } }));
});

publicRouter.get("/home", async (_req, res) => {
  const config = await loadConfig();
  const [banners, collections, occasions, artists, top, newest] = await Promise.all([
    prisma.banner.findMany({ where: { active: true }, orderBy: { sort: "asc" } }),
    prisma.collection.findMany({ orderBy: { sort: "asc" } }),
    prisma.occasion.findMany({ orderBy: { sort: "asc" } }),
    prisma.artist.findMany({ where: { verified: true, suspended: false }, take: 6 }),
    prisma.artwork.findMany({ where: { status: "approved", fulfilment: { not: "commission" } }, orderBy: { rating: "desc" }, take: 8, include: { artist: artistSelect } }),
    prisma.artwork.findMany({ where: { status: "approved", fulfilment: { not: "commission" } }, orderBy: { createdAt: "desc" }, take: 8, include: { artist: artistSelect } }),
  ]);
  res.json({
    banners,
    collections,
    occasions,
    artists: artists.map(publicArtist),
    trending: (top as ArtworkWithArtist[]).map((a) => present(config, a)),
    newest: (newest as ArtworkWithArtist[]).map((a) => present(config, a)),
  });
});

publicRouter.get("/offers", async (_req, res) => {
  const coupons = await prisma.coupon.findMany({ where: { active: true, artistId: null }, orderBy: { createdAt: "asc" } });
  res.json(coupons.filter((c) => c.usageLimit === null || c.used < c.usageLimit).map(({ code, label, kind, value, min }) => ({ code, label, kind, value, min })));
});

publicRouter.get("/artworks", async (req, res) => {
  res.json(await listArtworks(parse(catalogQuery, req.query)));
});

publicRouter.get("/artworks/:slug", async (req, res) => {
  const config = await loadConfig();
  const found = await prisma.artwork.findFirst({
    where: { OR: [{ slug: param(req, "slug") }, { id: param(req, "slug") }], status: "approved" },
    include: { artist: true },
  });
  if (!found) throw notFound("Artwork not found");
  const [reviews, related] = await Promise.all([
    prisma.review.findMany({ where: { artworkId: found.id, status: "approved" }, orderBy: [{ helpful: "desc" }, { createdAt: "desc" }], take: 30 }),
    prisma.artwork.findMany({
      where: { status: "approved", id: { not: found.id }, fulfilment: { not: "commission" }, OR: [{ artistId: found.artistId }, { category: found.category }] },
      include: { artist: artistSelect },
      take: 4,
    }),
  ]);
  const { artist, ...artwork } = found;
  res.json({
    ...artwork,
    fromPrice: fromPrice(config, artwork),
    artist: publicArtist(artist),
    reviews: reviews.map(({ ownerId: _o, ...review }) => review),
    related: (related as ArtworkWithArtist[]).map((a) => present(config, a)),
    options: { sizes: config.sizes, materials: config.materials, frames: config.frames, personalizationFee: config.personalizationFee },
  });
});

const quoteBody = z.object({
  artworkId: z.string().optional(),
  fulfilment: z.string().optional(),
  sizeId: z.string().default("a3"),
  materialId: z.string().default("matte"),
  frameId: z.string().default("none"),
  quantity: z.coerce.number().int().min(1).max(50).default(1),
});

publicRouter.post("/pricing/quote", async (req, res) => {
  const body = parse(quoteBody, req.body);
  const config = await loadConfig();
  const artwork = body.artworkId ? await prisma.artwork.findUnique({ where: { id: body.artworkId } }) : null;
  if (body.artworkId && !artwork) throw notFound("Artwork not found");
  const price = unitPrice(config, {
    fulfilment: artwork?.fulfilment ?? body.fulfilment ?? "custom_print",
    basePrice: artwork?.basePrice ?? 0,
    priceFactor: artwork?.priceFactor ?? 1,
    sizeId: body.sizeId,
    materialId: body.materialId,
    frameId: body.frameId,
  });
  res.json({ unitPrice: price, quantity: body.quantity, total: price * body.quantity });
});

publicRouter.get("/pincode/:pin", (req, res) => {
  const info = pincodeInfo(param(req, "pin"));
  res.json({ pincode: param(req, "pin"), serviceable: info.ok, remote: info.remote, eta: info.eta, codAvailable: info.ok && !info.remote });
});

// ───────── artists ─────────

publicRouter.get("/artists", async (req, res) => {
  const { commission, medium } = parse(z.object({ commission: bool.optional(), medium: z.string().optional() }), req.query);
  const artists = await prisma.artist.findMany({
    where: { suspended: false, verified: true, ...(commission ? { commissionEnabled: true } : {}), ...(medium ? { mediums: { has: medium } } : {}) },
    orderBy: { name: "asc" },
  });
  res.json(artists.map(publicArtist));
});

publicRouter.get("/artists/:slug", async (req, res) => {
  const artist = await prisma.artist.findFirst({ where: { slug: param(req, "slug"), suspended: false } });
  if (!artist) throw notFound("Artist not found");
  const works = await listArtworks({ artist: artist.slug, page: 1, limit: 100, mode: "all" });
  res.json({ ...publicArtist(artist), artworks: works.items });
});

// ───────── curation ─────────

publicRouter.get("/collections", async (_req, res) => {
  res.json(await prisma.collection.findMany({ orderBy: { sort: "asc" } }));
});

publicRouter.get("/collections/:slug", async (req, res) => {
  const collection = await prisma.collection.findUnique({ where: { slug: param(req, "slug") } });
  if (!collection) throw notFound("Collection not found");
  const items = (await artworksByIds(collection.ids)).filter((a) => a.status === "approved");
  res.json({ ...collection, artworks: items });
});

publicRouter.get("/occasions", async (_req, res) => {
  res.json(await prisma.occasion.findMany({ orderBy: { sort: "asc" } }));
});

publicRouter.get("/occasions/:slug", async (req, res) => {
  const occasion = await prisma.occasion.findUnique({ where: { slug: param(req, "slug") } });
  if (!occasion) throw notFound("Occasion not found");
  const works = await listArtworks({ mode: "occasion", value: occasion.title, page: 1, limit: 100 });
  res.json({ ...occasion, artworks: works.items });
});

publicRouter.get("/colours", async (_req, res) => res.json((await loadConfig()).colours));
publicRouter.get("/rooms", async (_req, res) => res.json((await loadConfig()).rooms));
publicRouter.get("/frames", async (_req, res) => res.json((await loadConfig()).frames));

// ───────── search ─────────

publicRouter.get("/search", async (req, res) => {
  const query = parse(catalogQuery.extend({ log: bool.default(true) }), req.query);
  const result = await listArtworks({ ...query, mode: query.mode ?? "all" });
  if (query.q?.trim() && query.log) {
    await prisma.searchLog.create({ data: { ownerId: req.ownerId, query: query.q.trim().slice(0, 120), results: result.total } });
  }
  res.json(result);
});

publicRouter.get("/search/suggest", async (req, res) => {
  const { q } = parse(z.object({ q: z.string().min(1).max(60) }), req.query);
  const [artworks, artists] = await Promise.all([
    prisma.artwork.findMany({ where: { status: "approved" }, include: { artist: artistSelect } }),
    prisma.artist.findMany({ where: { suspended: false, verified: true } }),
  ]);
  const works = (artworks as ArtworkWithArtist[]).filter((a) => matches(q, a, a.artist.name)).slice(0, 6);
  res.json({
    artworks: works.map((a) => ({ id: a.id, slug: a.slug, title: a.title, artist: a.artist.name, image: a.image })),
    artists: artists.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())).slice(0, 4).map((a) => ({ slug: a.slug, name: a.name })),
  });
});

// ───────── content ─────────

publicRouter.get("/blog", async (_req, res) => {
  res.json(await prisma.post.findMany({ where: { published: true }, orderBy: { createdAt: "desc" } }));
});

publicRouter.get("/blog/:slug", async (req, res) => {
  const post = await prisma.post.findFirst({ where: { slug: param(req, "slug"), published: true } });
  if (!post) throw notFound("Post not found");
  res.json(post);
});

publicRouter.get("/policies", async (_req, res) => res.json(await prisma.policy.findMany()));

publicRouter.get("/policies/:slug", async (req, res) => {
  const policy = await prisma.policy.findUnique({ where: { slug: param(req, "slug") } });
  if (!policy) throw notFound("Policy not found");
  res.json(policy);
});

// ───────── forms ─────────

const ticketBody = z.object({
  name: z.string().min(1).max(80).optional(),
  subject: z.string().min(2).max(160),
  body: z.string().min(2).max(4000),
  orderId: z.string().optional(),
});

publicRouter.post("/support/tickets", async (req, res) => {
  const body = parse(ticketBody, req.body);
  const customer = req.customerId ? await prisma.customer.findUnique({ where: { id: req.customerId } }) : null;
  const ticket = await prisma.ticket.create({
    data: {
      id: uid("T"),
      ownerId: req.ownerId,
      from: customer?.name ?? body.name ?? "Guest",
      subject: body.subject,
      orderId: body.orderId,
      body: body.body,
      channel: "Site",
    },
  });
  res.status(201).json(ticket);
});

const leadBody = z.object({
  company: z.string().min(1).max(120),
  contact: z.string().min(1).max(80),
  email: z.string().email().optional(),
  city: z.string().min(1).max(60),
  brief: z.string().min(2).max(2000),
  quantity: z.coerce.number().int().min(1).max(100000),
  budget: z.coerce.number().int().min(0).max(100000000),
});

publicRouter.post("/b2b/leads", async (req, res) => {
  const body = parse(leadBody, req.body);
  res.status(201).json(await prisma.b2BLead.create({ data: { id: uid("B2B"), ...body } }));
});

const giftBody = z.object({
  amount: z.coerce.number().int().min(100).max(100000),
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
  email: z.string().email(),
  message: z.string().max(500).optional(),
  theme: z.string().min(1).max(40),
  sendOn: z.string().max(40).optional(),
});

publicRouter.post("/gift-cards", async (req, res) => {
  const card = await issueGiftCard(parse(giftBody, req.body));
  res.status(201).json(card);
});

publicRouter.get("/gift-cards/balance", async (req, res) => {
  const { code } = parse(z.object({ code: z.string().min(3) }), req.query);
  res.json(await balanceOf(code));
});
