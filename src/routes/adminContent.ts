import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { badRequest, conflict, notFound, param, parse, slugify, uid } from "../lib/http";
import { actorLabel, needAdmin, roleMatrix, staffGate } from "../lib/identity";
import { resolveOne } from "../lib/media";
import { canonicalMediaUrl } from "../lib/storage";
import { audit } from "../services/audit";
import { loadMenu, menuSchema, saveMenu } from "../services/menu";
import { analyticsOverview } from "../services/analytics";
import { announcementSchema, loadAnnouncement, saveAnnouncement } from "../services/announcement";
import { commissions } from "../services/commissions";
import { issueGiftCard } from "../services/giftcards";
import { grossMerchandiseValue } from "./admin";

export const adminContentRouter = Router();
adminContentRouter.use(staffGate);

// ───────── CMS ─────────

const bannerBody = z.object({
  eyebrow: z.string().max(60).default(""),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(300).default(""),
  href: z.string().max(200).default("/"),
  image: z.string().default(""),
  active: z.boolean().default(true),
  sort: z.coerce.number().int().default(0),
});

adminContentRouter.get("/cms", needAdmin("cms"), async (_req, res) => {
  const [banners, posts, policies, collections, occasions] = await Promise.all([
    prisma.banner.findMany({ orderBy: { sort: "asc" } }),
    prisma.blog.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.policy.findMany(),
    prisma.collection.findMany({ orderBy: { sort: "asc" } }),
    prisma.occasion.findMany({ orderBy: { sort: "asc" } }),
  ]);
  res.json({ banners, posts, policies, collections: collections.map((collection) => ({ ...collection, image: canonicalMediaUrl(collection.image) })), occasions });
});

adminContentRouter.get("/cms/menu", needAdmin("cms"), async (_req, res) => {
  res.json(await loadMenu());
});

adminContentRouter.put("/cms/menu", needAdmin("cms"), async (req, res) => {
  const menu = await saveMenu(req, parse(menuSchema, req.body));
  await audit(prisma, actorLabel(req), "Updated storefront menu settings");
  res.json(menu);
});

adminContentRouter.post("/cms/banners", needAdmin("cms"), async (req, res) => {
  const body = parse(bannerBody, req.body);
  const image = body.image ? await resolveOne(req, body.image, ["cms"]) : "";
  const banner = await prisma.banner.create({ data: { id: uid("b"), ...body, image } });
  await audit(prisma, actorLabel(req), `Created banner "${banner.title}"`);
  res.status(201).json(banner);
});

adminContentRouter.patch("/cms/banners/:id", needAdmin("cms"), async (req, res) => {
  const body = parse(bannerBody.partial(), req.body);
  if (body.image) body.image = await resolveOne(req, body.image, ["cms"]);
  const banner = await prisma.banner.update({ where: { id: param(req, "id") }, data: body });
  await audit(prisma, actorLabel(req), `Updated banner "${banner.title}"`);
  res.json(banner);
});

adminContentRouter.delete("/cms/banners/:id", needAdmin("cms"), async (req, res) => {
  await prisma.banner.delete({ where: { id: param(req, "id") } });
  await audit(prisma, actorLabel(req), `Deleted banner ${param(req, "id")}`);
  res.status(204).end();
});

const postBody = z.object({ title: z.string().min(2).max(160), lede: z.string().max(500).default(""), body: z.string().max(50000).default(""), published: z.boolean().default(true) });

adminContentRouter.post("/cms/posts", needAdmin("cms"), async (req, res) => {
  const body = parse(postBody, req.body);
  const slug = slugify(body.title);
  if (await prisma.blog.findUnique({ where: { slug } })) throw conflict("A post with that title exists");
  res.status(201).json(await prisma.blog.create({ data: { slug, ...body } }));
});

adminContentRouter.patch("/cms/posts/:slug", needAdmin("cms"), async (req, res) => {
  res.json(await prisma.blog.update({ where: { slug: param(req, "slug") }, data: parse(postBody.partial(), req.body) }));
});

adminContentRouter.delete("/cms/posts/:slug", needAdmin("cms"), async (req, res) => {
  await prisma.blog.delete({ where: { slug: param(req, "slug") } });
  res.status(204).end();
});

adminContentRouter.put("/cms/policies/:slug", needAdmin("cms"), async (req, res) => {
  const body = parse(z.object({ title: z.string().min(2).max(80), body: z.string().min(2).max(50000) }), req.body);
  const slug = param(req, "slug");
  const policy = await prisma.policy.upsert({ where: { slug }, create: { slug, ...body }, update: body });
  await audit(prisma, actorLabel(req), `Published policy ${slug}`);
  res.json(policy);
});

const collectionBody = z.object({
  title: z.string().min(2).max(80),
  lede: z.string().max(300).default(""),
  ids: z.array(z.string()).max(100).default([]),
  sort: z.coerce.number().int().default(0),
  image: z.string().max(2000).default(""),
  menuPlacement: z.enum(["collections", "new-arrivals", "featured", "artwork-gifts", "all-artwork", "hidden"]).default("collections"),
});

adminContentRouter.post("/cms/collections", needAdmin("cms"), async (req, res) => {
  const body = parse(collectionBody, req.body);
  const slug = slugify(body.title);
  if (await prisma.collection.findUnique({ where: { slug } })) throw conflict("A collection with that title exists");
  const image = body.image ? await resolveOne(req, body.image, ["cms"]) : "";
  const collection = await prisma.collection.create({ data: { slug, ...body, image } });
  await audit(prisma, actorLabel(req), `Created collection "${collection.title}"`);
  res.status(201).json({ ...collection, image: canonicalMediaUrl(collection.image) });
});

adminContentRouter.patch("/cms/collections/:slug", needAdmin("cms"), async (req, res) => {
  const body = parse(collectionBody.partial(), req.body);
  if (body.image) body.image = await resolveOne(req, body.image, ["cms"]);
  const collection = await prisma.collection.update({ where: { slug: param(req, "slug") }, data: body });
  await audit(prisma, actorLabel(req), `Updated collection "${collection.title}"`);
  res.json({ ...collection, image: canonicalMediaUrl(collection.image) });
});

adminContentRouter.delete("/cms/collections/:slug", needAdmin("cms"), async (req, res) => {
  const slug = param(req, "slug");
  const existing = await prisma.collection.findUnique({ where: { slug } });
  if (!existing) throw notFound("Collection not found");
  await prisma.collection.delete({ where: { slug } });
  await audit(prisma, actorLabel(req), `Deleted collection "${existing.title}"`);
  res.status(204).end();
});

const occasionBody = z.object({ title: z.string().min(2).max(60), lede: z.string().max(300).default(""), sort: z.coerce.number().int().default(0) });

adminContentRouter.post("/cms/occasions", needAdmin("cms"), async (req, res) => {
  const body = parse(occasionBody, req.body);
  const slug = slugify(body.title);
  if (await prisma.occasion.findUnique({ where: { slug } })) throw conflict("That occasion exists");
  res.status(201).json(await prisma.occasion.create({ data: { slug, ...body } }));
});

adminContentRouter.patch("/cms/occasions/:slug", needAdmin("cms"), async (req, res) => {
  res.json(await prisma.occasion.update({ where: { slug: param(req, "slug") }, data: parse(occasionBody.partial(), req.body) }));
});

adminContentRouter.delete("/cms/occasions/:slug", needAdmin("cms"), async (req, res) => {
  await prisma.occasion.delete({ where: { slug: param(req, "slug") } });
  res.status(204).end();
});

// ───────── promotions and coupons ─────────

adminContentRouter.get("/promotions", needAdmin("promotions"), async (_req, res) => {
  const [boosts, coupons] = await Promise.all([
    prisma.promotion.findMany({ include: { artist: { select: { name: true, boostedUntil: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.coupon.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  res.json({ boosts, coupons });
});

adminContentRouter.post("/promotions/:id/decision", needAdmin("promotions"), async (req, res) => {
  const { decision } = parse(z.object({ decision: z.enum(["approved", "rejected"]) }), req.body);
  const promo = await prisma.promotion.findUnique({ where: { id: param(req, "id") }, include: { artist: true } });
  if (!promo) throw notFound("Boost request not found");
  if (promo.status !== "pending") throw conflict(`Request is already ${promo.status}`);
  if (decision === "approved") {
    const start = promo.artist.boostedUntil && promo.artist.boostedUntil > new Date() ? promo.artist.boostedUntil : new Date();
    await prisma.artist.update({ where: { id: promo.artistId }, data: { boostedUntil: new Date(start.getTime() + promo.days * 86400000) } });
  }
  const updated = await prisma.promotion.update({ where: { id: promo.id }, data: { status: decision } });
  await audit(prisma, actorLabel(req), `${decision === "approved" ? "Approved" : "Rejected"} ${promo.days}-day boost for ${promo.artist.name}`);
  res.json(updated);
});

const dateField = z.preprocess((value) => (value === "" ? null : value), z.coerce.date().nullable());
const couponShape = {
  label: z.string().trim().min(2).max(120),
  kind: z.enum(["percent", "flat", "shipping"]),
  value: z.coerce.number().int().min(0).max(100000),
  min: z.coerce.number().int().min(0),
  usageLimit: z.coerce.number().int().min(1).nullable(),
  active: z.boolean(),
  oncePerCustomer: z.boolean(),
  startsAt: dateField,
  endsAt: dateField,
  collectionSlugs: z.array(z.string().trim().min(1).max(80)).max(50),
};
const couponCode = z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{3,20}$/, "Use 3–20 letters or digits"));
// Optional fields are left undefined (not defaulted) so editing one setting never resets the others.
const couponCreate = z.object({ code: couponCode, ...couponShape }).partial({
  min: true, usageLimit: true, active: true, oncePerCustomer: true, startsAt: true, endsAt: true, collectionSlugs: true,
});
const couponPatch = z.object(couponShape).partial();

type CouponFields = {
  kind: string; value: number; startsAt: Date | null; endsAt: Date | null; collectionSlugs: string[];
};

async function assertCouponRules(coupon: CouponFields) {
  if (coupon.kind === "percent" && (coupon.value < 1 || coupon.value > 100)) throw badRequest("A percentage must be between 1 and 100");
  if (coupon.kind === "flat" && coupon.value < 1) throw badRequest("Enter an amount off");
  if (coupon.startsAt && coupon.endsAt && coupon.endsAt <= coupon.startsAt) throw badRequest("The end date must be after the start date");
  const slugs = [...new Set(coupon.collectionSlugs)];
  if (slugs.length && (await prisma.collection.count({ where: { slug: { in: slugs } } })) !== slugs.length) throw badRequest("One of the chosen collections no longer exists");
}

const couponStatus = (coupon: { active: boolean; used: number; usageLimit: number | null; startsAt: Date | null; endsAt: Date | null }, now = new Date()) => {
  if (!coupon.active) return "disabled";
  if (coupon.endsAt && coupon.endsAt < now) return "expired";
  if (coupon.startsAt && coupon.startsAt > now) return "scheduled";
  if (coupon.usageLimit !== null && coupon.used >= coupon.usageLimit) return "exhausted";
  return "active";
};

const withStatus = <T extends { active: boolean; used: number; usageLimit: number | null; startsAt: Date | null; endsAt: Date | null; artistId: string | null }>(coupon: T) =>
  ({ ...coupon, status: couponStatus(coupon), source: coupon.artistId ? "creator" : "store" });

adminContentRouter.get("/discounts", needAdmin("promotions"), async (_req, res) => {
  res.json((await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } })).map(withStatus));
});

adminContentRouter.post("/coupons", needAdmin("promotions"), async (req, res) => {
  const body = parse(couponCreate, req.body);
  const data = {
    code: body.code, label: body.label, kind: body.kind, value: body.kind === "shipping" ? 0 : body.value,
    min: body.min ?? 0, usageLimit: body.usageLimit ?? null, active: body.active ?? true,
    oncePerCustomer: body.oncePerCustomer ?? false, startsAt: body.startsAt ?? null, endsAt: body.endsAt ?? null,
    collectionSlugs: [...new Set(body.collectionSlugs ?? [])],
  };
  await assertCouponRules(data);
  if (await prisma.coupon.findFirst({ where: { code: { equals: data.code, mode: "insensitive" } } })) throw conflict("That code already exists");
  const coupon = await prisma.coupon.create({ data });
  await audit(prisma, actorLabel(req), `Created discount code ${coupon.code}`);
  res.status(201).json(withStatus(coupon));
});

adminContentRouter.patch("/coupons/:code", needAdmin("promotions"), async (req, res) => {
  const patch = parse(couponPatch, req.body);
  const existing = await prisma.coupon.findUnique({ where: { code: param(req, "code") } });
  if (!existing) throw notFound("Discount code not found");
  const merged = { ...existing, ...patch };
  if (merged.kind === "shipping") merged.value = 0;
  if (patch.collectionSlugs) merged.collectionSlugs = [...new Set(patch.collectionSlugs)];
  await assertCouponRules(merged);
  const { code: _code, createdAt: _createdAt, artistId: _artistId, used: _used, ...data } = merged;
  const coupon = await prisma.coupon.update({ where: { code: existing.code }, data });
  await audit(prisma, actorLabel(req), `Updated discount code ${coupon.code}`);
  res.json(withStatus(coupon));
});

// A code that has been redeemed is only switched off so past orders keep their reference.
adminContentRouter.delete("/coupons/:code", needAdmin("promotions"), async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { code: param(req, "code") } });
  if (!existing) throw notFound("Discount code not found");
  if (existing.used > 0) {
    await prisma.coupon.update({ where: { code: existing.code }, data: { active: false } });
    await audit(prisma, actorLabel(req), `Deactivated discount code ${existing.code}`);
    return void res.json({ deleted: false });
  }
  await prisma.coupon.delete({ where: { code: existing.code } });
  await audit(prisma, actorLabel(req), `Deleted discount code ${existing.code}`);
  res.json({ deleted: true });
});

adminContentRouter.get("/cms/announcement", needAdmin("cms"), async (_req, res) => {
  res.json(await loadAnnouncement());
});

adminContentRouter.put("/cms/announcement", needAdmin("cms"), async (req, res) => {
  const saved = await saveAnnouncement(parse(announcementSchema, req.body));
  await audit(prisma, actorLabel(req), "Updated announcement bar");
  res.json(saved);
});

adminContentRouter.get("/analytics/overview", needAdmin("analytics"), async (req, res) => {
  const { from, to } = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }), req.query);
  res.json(await analyticsOverview(from, to));
});

// ───────── review moderation ─────────

adminContentRouter.get("/reviews", needAdmin("reviews"), async (req, res) => {
  const { status } = parse(z.object({ status: z.string().optional() }), req.query);
  res.json(await prisma.review.findMany({ where: status ? { status } : {}, include: { product: { select: { title: true, slug: true } } }, orderBy: { createdAt: "desc" } }));
});

// The seeded rating covers reviews that predate this table, so the aggregate is adjusted rather than recomputed.
adminContentRouter.post("/reviews/:id/moderate", needAdmin("reviews"), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["approved", "rejected", "pending"]) }), req.body);
  const review = await prisma.review.findUnique({ where: { id: param(req, "id") }, include: { product: true } });
  if (!review) throw notFound("Review not found");
  if (review.status !== status) {
    const { rating, reviewCount } = review.product;
    let nextCount = reviewCount;
    let nextRating = rating;
    if (status === "approved") {
      nextCount = reviewCount + 1;
      nextRating = (rating * reviewCount + review.rating) / nextCount;
    } else if (review.status === "approved") {
      nextCount = Math.max(0, reviewCount - 1);
      nextRating = nextCount ? Math.max(0, (rating * reviewCount - review.rating) / nextCount) : 0;
    }
    await prisma.$transaction([
      prisma.review.update({ where: { id: review.id }, data: { status } }),
      prisma.product.update({ where: { id: review.productId }, data: { reviewCount: nextCount, rating: Math.round(nextRating * 10) / 10 } }),
    ]);
  }
  await audit(prisma, actorLabel(req), `Review ${review.id} marked ${status}`);
  res.json(await prisma.review.findUnique({ where: { id: review.id } }));
});

// ───────── support ─────────

adminContentRouter.get("/tickets", needAdmin("support"), async (req, res) => {
  const { status, source } = parse(z.object({ status: z.string().optional(), source: z.string().optional() }), req.query);
  res.json(await prisma.ticket.findMany({ where: { ...(status ? { status } : {}), ...(source ? { source } : {}) }, orderBy: { createdAt: "desc" } }));
});

adminContentRouter.patch("/tickets/:id", needAdmin("support"), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["open", "pending", "resolved"]) }), req.body);
  const ticket = await prisma.ticket.update({ where: { id: param(req, "id") }, data: { status } });
  await audit(prisma, actorLabel(req), `Ticket ${ticket.id} set to ${status}`);
  res.json(ticket);
});

adminContentRouter.post("/tickets/:id/reply", needAdmin("support"), async (req, res) => {
  const { message } = parse(z.object({ message: z.string().min(1).max(4000) }), req.body);
  const ticket = await prisma.ticket.findUnique({ where: { id: param(req, "id") } });
  if (!ticket) throw notFound("Ticket not found");
  const replies = [...((ticket.replies as unknown[]) ?? []), { at: new Date().toISOString(), by: actorLabel(req), message }];
  res.json(await prisma.ticket.update({ where: { id: ticket.id }, data: { replies: replies as never, status: ticket.status === "open" ? "pending" : ticket.status } }));
});

// ───────── B2B ─────────

adminContentRouter.get("/b2b", needAdmin("b2b"), async (_req, res) => {
  res.json(await prisma.bulkOrder.findMany({ orderBy: { createdAt: "desc" } }));
});

adminContentRouter.patch("/b2b/:id", needAdmin("b2b"), async (req, res) => {
  const body = parse(
    z.object({
      status: z.enum(["new", "quote_draft", "quoted", "won", "lost"]).optional(),
      quote: z.object({ amount: z.coerce.number().int().min(1), note: z.string().max(1000).default("") }).optional(),
    }),
    req.body,
  );
  const lead = await prisma.bulkOrder.update({
    where: { id: param(req, "id") },
    data: { ...(body.quote ? { quote: body.quote, status: body.status ?? "quoted" } : body.status ? { status: body.status } : {}) },
  });
  await audit(prisma, actorLabel(req), `B2B ${lead.id} (${lead.company}) is ${lead.status}`);
  res.json(lead);
});

// ───────── commissions and gift cards ─────────

adminContentRouter.get("/commissions", needAdmin("commissions"), async (_req, res) => {
  res.json(await prisma.commission.findMany({ include: { artist: { select: { name: true } } }, orderBy: { createdAt: "desc" } }));
});

adminContentRouter.post("/commissions/:id/cancel", needAdmin("commissions"), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().max(300).default("Cancelled by admin") }), req.body ?? {});
  const result = await commissions.cancelByAdmin(param(req, "id"), reason);
  await audit(prisma, actorLabel(req), `Cancelled commission ${result.id}`);
  res.json(result);
});

adminContentRouter.get("/gift-cards", needAdmin("gift-cards"), async (_req, res) => {
  res.json(await prisma.giftCard.findMany({ orderBy: { createdAt: "desc" } }));
});

adminContentRouter.post("/gift-cards", needAdmin("gift-cards"), async (req, res) => {
  const body = parse(
    z.object({ amount: z.coerce.number().int().min(100).max(100000), to: z.string().min(1).max(80), email: z.string().email(), message: z.string().max(500).optional(), theme: z.string().default("Studio"), sendOn: z.string().max(40).optional() }),
    req.body,
  );
  const card = await issueGiftCard({ ...body, from: "Studio" });
  await audit(prisma, actorLabel(req), `Issued gift card ${card.code} (₹${card.amount})`);
  res.status(201).json(card);
});

adminContentRouter.post("/gift-cards/:id/void", needAdmin("gift-cards"), async (req, res) => {
  const card = await prisma.giftCard.update({ where: { id: param(req, "id") }, data: { status: "void" } });
  await audit(prisma, actorLabel(req), `Gift card ${card.id} set to void`);
  res.json(card);
});

// ───────── roles, audit, settings, analytics ─────────

const ROLE_NOTES: Record<string, string> = {
  moderator: "Product, creators, copyright, reviews. No payout release.",
  support: "Customers, orders, tickets, returns. No pricing, no bank details.",
  operations: "Jobs, shipping, returns. No campaigns, no permissions.",
  finance: "Payments, payouts, reports, gift cards. No publishing.",
  marketing: "CMS, promotions, analytics. No refunds or payouts.",
  super: "Everything. Use it rarely.",
};

adminContentRouter.get("/roles", needAdmin("roles"), (_req, res) => {
  res.json(Object.entries(roleMatrix()).map(([role, desks]) => ({ role, desks, note: ROLE_NOTES[role] })));
});

adminContentRouter.get("/audit", needAdmin("audit"), async (req, res) => {
  const { limit, q } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), q: z.string().optional() }), req.query);
  res.json(await prisma.activity.findMany({ where: q ? { OR: [{ action: { contains: q, mode: "insensitive" } }, { actor: { contains: q, mode: "insensitive" } }] } : {}, orderBy: { at: "desc" }, take: limit }));
});

adminContentRouter.get("/settings", needAdmin("settings"), async (_req, res) => {
  const config = await prisma.config.findUniqueOrThrow({ where: { id: 1 } });
  res.json({ capacity: config.capacity, holidays: config.holidays, partnerName: config.partnerName });
});

adminContentRouter.put("/settings", needAdmin("settings"), async (req, res) => {
  const body = parse(z.object({ capacity: z.coerce.number().int().min(1).max(100000).optional(), holidays: z.string().max(300).optional(), partnerName: z.string().min(1).max(80).optional() }), req.body);
  const config = await prisma.config.update({ where: { id: 1 }, data: body });
  await audit(prisma, actorLabel(req), "Updated system settings");
  res.json({ capacity: config.capacity, holidays: config.holidays, partnerName: config.partnerName });
});

adminContentRouter.get("/analytics", needAdmin("analytics"), async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86400000);
  const [searches, wishlist, orders, gmv, logs, top] = await Promise.all([
    prisma.searchHistory.count({ where: { createdAt: { gte: since } } }),
    prisma.wishlistItem.count(),
    prisma.order.count({ where: { createdAt: { gte: since } } }),
    grossMerchandiseValue(),
    prisma.searchHistory.findMany({ where: { createdAt: { gte: since } }, select: { query: true, results: true } }),
    prisma.orderItem.groupBy({ by: ["title"], _sum: { quantity: true }, where: { status: { notIn: ["cancelled", "pending_payment"] } }, orderBy: { _sum: { quantity: "desc" } }, take: 5 }),
  ]);
  const counts = new Map<string, number>();
  for (const log of logs) counts.set(log.query.toLowerCase(), (counts.get(log.query.toLowerCase()) ?? 0) + 1);
  const zero = [...new Set(logs.filter((log) => log.results === 0).map((log) => log.query.toLowerCase()))];
  res.json({
    windowDays: 30,
    searches,
    zeroResultSearches: zero,
    topSearches: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([query, count]) => ({ query, count })),
    wishlist,
    orders,
    gmv,
    topSellers: top.map((row) => ({ title: row.title, units: row._sum.quantity ?? 0 })),
    searchToOrder: searches ? Math.round((orders / searches) * 1000) / 10 : 0,
  });
});
