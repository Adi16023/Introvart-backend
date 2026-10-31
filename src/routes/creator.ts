import { Router } from "express";
import { z } from "zod";
import { json, prisma } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, param, parse, slugify, uid } from "../lib/http";
import { needCreator, staffGate } from "../lib/identity";
import { ensureDispatchAwb } from "../services/shipping";
import { resolveOne } from "../lib/media";
import { audit } from "../services/audit";
import { commissions } from "../services/commissions";
import { ledgerFor } from "../services/earnings";

export const creatorRouter = Router();

// ───────── registration (open) ─────────

creatorRouter.post("/register", async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().min(2).max(80),
      email: z.string().email(),
      phone: z.string().regex(/^[0-9+\-\s]{10,15}$/),
      accountType: z.enum(["Individual", "Business"]).default("Individual"),
      city: z.string().max(60).default(""),
    }),
    req.body,
  );
  const base = slugify(body.name) || "studio";
  let slug = base;
  for (let n = 2; await prisma.artist.findUnique({ where: { slug } }); n += 1) slug = `${base}-${n}`;
  const artist = await prisma.artist.create({
    data: { id: uid("cr").toLowerCase(), slug, name: body.name, email: body.email.toLowerCase(), phone: body.phone, accountType: body.accountType, city: body.city },
  });
  res.status(201).json(artist);
});

creatorRouter.use(staffGate, needCreator);

// ───────── profile and KYC ─────────

creatorRouter.get("/me", async (req, res) => {
  res.json(await prisma.artist.findUnique({ where: { id: req.creatorId } }));
});

creatorRouter.patch("/profile", async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().min(2).max(80).optional(),
      bio: z.string().max(2000).optional(),
      city: z.string().max(60).optional(),
      social: z.string().max(200).optional(),
      cover: z.string().optional(),
      portrait: z.string().optional(),
      styles: z.array(z.string().max(40)).max(10).optional(),
      commissionEnabled: z.boolean().optional(),
      mediums: z.array(z.string().max(40)).max(10).optional(),
      priceFrom: z.coerce.number().int().min(0).optional(),
      turnaround: z.string().max(40).optional(),
      slots: z.coerce.number().int().min(0).max(50).optional(),
    }),
    req.body,
  );
  const data = { ...body };
  if (body.cover) data.cover = await resolveOne(req, body.cover, ["creator-profile"], "cover");
  if (body.portrait) data.portrait = await resolveOne(req, body.portrait, ["creator-profile"], "portrait");
  res.json(await prisma.artist.update({ where: { id: req.creatorId }, data }));
});

creatorRouter.put("/kyc", async (req, res) => {
  const body = parse(
    z.object({
      pan: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN looks wrong")),
      bank: z.string().min(3).max(60),
      ifsc: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC looks wrong")),
      gst: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/, "GSTIN looks wrong")).optional().or(z.literal("").transform(() => undefined)),
    }),
    req.body,
  );
  const artist = await prisma.artist.update({ where: { id: req.creatorId }, data: { ...body, gst: body.gst ?? null, kyc: "pending" } });
  await audit(prisma, artist.name, "KYC submitted");
  res.json({ kyc: artist.kyc, pan: artist.pan, bank: artist.bank, ifsc: artist.ifsc, gst: artist.gst });
});

creatorRouter.get("/kyc", async (req, res) => {
  const a = await prisma.artist.findUnique({ where: { id: req.creatorId } });
  res.json({ kyc: a?.kyc, pan: a?.pan, bank: a?.bank, ifsc: a?.ifsc, gst: a?.gst, verified: a?.verified });
});

// ───────── dashboard ─────────

creatorRouter.get("/dashboard", async (req, res) => {
  const id = req.creatorId!;
  const [ledger, waiting, pendingQuotes] = await Promise.all([
    ledgerFor(id),
    prisma.orderItem.findMany({ where: { creatorId: id, status: "confirmed", fulfilment: { in: ["original", "seller_fulfilled"] } } }),
    prisma.commission.findMany({ where: { artistId: id, status: "requested" } }),
  ]);
  const artist = ledger!.artist;
  const earned = ledger!.rows.filter((row) => row.state !== "void").reduce((sum, row) => sum + row.share, 0);
  res.json({
    city: artist.city,
    sales: ledger!.rows.filter((row) => row.state !== "void").length,
    earnings: earned,
    slots: artist.slots,
    kyc: artist.kyc,
    needsYou: [
      ...waiting.map((item) => `${item.orderId} · ${item.title} is waiting for you to accept it.`),
      ...pendingQuotes.map((c) => `${c.id} needs a quote.`),
      ...(artist.kyc !== "verified" ? [`KYC is ${artist.kyc}. Payouts stay held.`] : []),
    ],
  });
});

// ───────── products ─────────

const productBody = z.object({
  title: z.string().min(2).max(120),
  story: z.string().min(1).max(3000),
  category: z.string().min(1).max(60).default("Abstract"),
  fulfilment: z.enum(["platform_pod", "original", "personalized", "seller_fulfilled"]).default("platform_pod"),
  basePrice: z.coerce.number().int().min(1).max(10000000),
  image: z.string().min(1),
  roomImage: z.string().optional(),
  colours: z.array(z.string()).max(6).default([]),
  rooms: z.array(z.string()).max(7).default([]),
  occasions: z.array(z.string()).max(7).default([]),
  orientation: z.enum(["portrait", "landscape", "square"]).default("portrait"),
  style: z.string().max(60).optional(),
  stock: z.coerce.number().int().min(0).max(100000).optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
  personalization: z.array(z.object({ key: z.string().min(1).max(30), label: z.string().min(1).max(60), placeholder: z.string().max(80).default("") })).max(8).optional(),
  rightsDeclared: z.boolean().default(false),
  submit: z.boolean().default(true),
});

async function createProduct(artistId: string, body: z.infer<typeof productBody>) {
  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: artistId } });
  const base = slugify(body.title) || uid("work").toLowerCase();
  let slug = base;
  for (let n = 2; await prisma.product.findUnique({ where: { slug } }); n += 1) slug = `${base}-${n}`;
  const sellerShipped = body.fulfilment === "original" || body.fulfilment === "seller_fulfilled";
  if (body.fulfilment === "personalized" && !body.personalization?.length) throw badRequest("A personalised template needs at least one field");
  const tags = new Set(body.tags);
  if (body.rightsDeclared) tags.add("rights-declared");
  const canSubmit = body.submit && body.rightsDeclared;
  return prisma.product.create({
    data: {
      id: uid("AW"),
      slug,
      title: body.title,
      artistId,
      story: body.story,
      image: body.image,
      roomImage: body.roomImage ?? body.image,
      category: body.category,
      colours: body.colours,
      rooms: body.rooms,
      occasions: body.occasions,
      orientation: body.orientation,
      style: body.style ?? body.category,
      fulfilment: body.fulfilment,
      basePrice: body.basePrice,
      royaltyRate: artist.royaltyRate,
      stock: sellerShipped ? (body.stock ?? 1) : null,
      status: canSubmit ? "submitted" : "draft",
      tags: [...tags],
      personalization: body.personalization ? json(body.personalization) : undefined,
    },
  });
}

creatorRouter.get("/products", async (req, res) => {
  res.json(await prisma.product.findMany({ where: { artistId: req.creatorId }, orderBy: { createdAt: "desc" } }));
});

creatorRouter.post("/products", async (req, res) => {
  const body = parse(productBody, req.body);
  const image = await resolveOne(req, body.image, ["product"]);
  const roomImage = body.roomImage ? await resolveOne(req, body.roomImage, ["product"], "roomImage") : image;
  res.status(201).json(await createProduct(req.creatorId!, { ...body, image, roomImage }));
});

async function ownProduct(req: { creatorId?: string }, id: string) {
  const product = await prisma.product.findFirst({ where: { id, artistId: req.creatorId } });
  if (!product) throw notFound("Product not found");
  return product;
}

const CONTENT_FIELDS = ["title", "story", "image", "roomImage", "category", "style", "colours", "rooms", "occasions", "personalization"] as const;

creatorRouter.patch("/products/:id", async (req, res) => {
  const product = await ownProduct(req, param(req, "id"));
  if (product.status === "suspended" || product.status === "rejected") throw forbidden(`A ${product.status} work cannot be edited`);
  const body = parse(productBody.omit({ fulfilment: true, rightsDeclared: true, submit: true, stock: true }).partial(), req.body);
  const { personalization, ...rest } = body;
  if (rest.image) rest.image = await resolveOne(req, rest.image, ["product"]);
  if (rest.roomImage) rest.roomImage = await resolveOne(req, rest.roomImage, ["product"], "roomImage");
  const touchesContent = CONTENT_FIELDS.some((field) => (body as Record<string, unknown>)[field] !== undefined);
  const updated = await prisma.product.update({
    where: { id: product.id },
    data: {
      ...rest,
      ...(personalization ? { personalization: json(personalization) } : {}),
      // Edits to a live listing go back through moderation.
      ...(product.status === "approved" && touchesContent ? { status: "submitted", moderatorNote: null } : {}),
    },
  });
  res.json(updated);
});

creatorRouter.post("/products/:id/rights", async (req, res) => {
  const product = await ownProduct(req, param(req, "id"));
  if (product.tags.includes("rights-declared")) {
    res.json(product);
    return;
  }
  res.json(await prisma.product.update({ where: { id: product.id }, data: { tags: [...product.tags, "rights-declared"] } }));
});

creatorRouter.post("/products/:id/submit", async (req, res) => {
  const product = await ownProduct(req, param(req, "id"));
  if (!["draft", "changes_required"].includes(product.status)) throw conflict(`A ${product.status.replaceAll("_", " ")} work cannot be submitted`);
  if (!product.tags.includes("rights-declared")) throw badRequest("Declare that you hold the rights first");
  res.json(await prisma.product.update({ where: { id: product.id }, data: { status: "submitted", moderatorNote: null } }));
});

creatorRouter.patch("/products/:id/stock", async (req, res) => {
  const { stock } = parse(z.object({ stock: z.coerce.number().int().min(0).max(100000) }), req.body);
  const product = await ownProduct(req, param(req, "id"));
  if (product.stock === null) throw badRequest("Prints are made to order and carry no count");
  res.json(await prisma.product.update({ where: { id: product.id }, data: { stock } }));
});

creatorRouter.delete("/products/:id", async (req, res) => {
  const product = await ownProduct(req, param(req, "id"));
  if (!["draft", "rejected"].includes(product.status)) throw conflict("Only drafts and rejected works can be deleted");
  if (await prisma.orderItem.count({ where: { productId: product.id } })) throw conflict("This work has orders against it");
  await prisma.product.delete({ where: { id: product.id } });
  res.status(204).end();
});

creatorRouter.get("/templates", async (req, res) => {
  res.json(await prisma.product.findMany({ where: { artistId: req.creatorId, fulfilment: "personalized" }, orderBy: { createdAt: "desc" } }));
});

creatorRouter.post("/templates", async (req, res) => {
  const body = parse(
    productBody.partial({ story: true, basePrice: true, category: true }).extend({
      personalization: productBody.shape.personalization.unwrap().min(1),
    }),
    req.body,
  );
  const image = await resolveOne(req, body.image, ["product"]);
  const roomImage = body.roomImage ? await resolveOne(req, body.roomImage, ["product"], "roomImage") : image;
  res.status(201).json(
    await createProduct(req.creatorId!, {
      ...body,
      fulfilment: "personalized",
      story: body.story ?? "Editable names on a fixed drawing.",
      image,
      roomImage,
      basePrice: body.basePrice ?? 1999,
      category: body.category ?? "Personalised",
      tags: [...(body.tags ?? []), "template"],
      submit: body.submit ?? false,
    } as z.infer<typeof productBody>),
  );
});

// ───────── orders and inventory ─────────

creatorRouter.get("/orders", async (req, res) => {
  const items = await prisma.orderItem.findMany({
    where: { creatorId: req.creatorId, order: { paymentStatus: { in: ["paid", "cod", "pending"] } } },
    include: { order: { select: { id: true, placedAt: true, address: true, customerName: true, paymentStatus: true } } },
    orderBy: { order: { createdAt: "desc" } },
  });
  res.json(
    items.map(({ order, ...item }) => ({
      ...item,
      order: { id: order.id, placedAt: order.placedAt, paymentStatus: order.paymentStatus },
      // Only works the creator ships themselves need a delivery address.
      shipTo: ["original", "seller_fulfilled"].includes(item.fulfilment) && item.status !== "pending_payment" ? { name: order.customerName, address: order.address } : null,
      printedByPlatform: !["original", "seller_fulfilled"].includes(item.fulfilment),
    })),
  );
});

async function ownSellerItem(req: { creatorId?: string }, orderId: string, itemId: string) {
  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId, creatorId: req.creatorId } });
  if (!item) throw notFound("Order line not found");
  if (!["original", "seller_fulfilled"].includes(item.fulfilment)) throw badRequest("The platform prints and ships this work");
  return item;
}

creatorRouter.post("/orders/:orderId/items/:itemId/accept", async (req, res) => {
  const item = await ownSellerItem(req, param(req, "orderId"), param(req, "itemId"));
  if (item.status !== "confirmed") throw conflict(`This line is ${item.status.replaceAll("_", " ")}`);
  res.json(await prisma.orderItem.update({ where: { id: item.id }, data: { status: "accepted" } }));
});

creatorRouter.post("/orders/:orderId/items/:itemId/dispatch", async (req, res) => {
  const { awb } = parse(z.object({ awb: z.string().min(4).max(40).optional() }), req.body ?? {});
  const item = await ownSellerItem(req, param(req, "orderId"), param(req, "itemId"));
  if (item.status !== "accepted") throw conflict("Accept the order before dispatching it");
  const assignedAwb = await ensureDispatchAwb(item.id, undefined, awb);
  if (!assignedAwb && !item.awb) throw badRequest("Book the parcel in Velocity or enter a real external courier AWB before dispatching.");
  res.json(await prisma.orderItem.update({ where: { id: item.id }, data: { status: "shipped", awb: assignedAwb ?? item.awb } }));
});

creatorRouter.get("/inventory", async (req, res) => {
  const works = await prisma.product.findMany({ where: { artistId: req.creatorId }, select: { id: true, title: true, fulfilment: true, stock: true, status: true }, orderBy: { title: "asc" } });
  res.json(works.map((work) => ({ ...work, madeToOrder: work.stock === null })));
});

// ───────── analytics, earnings, payouts ─────────

creatorRouter.get("/analytics", async (req, res) => {
  const works = await prisma.product.findMany({ where: { artistId: req.creatorId } });
  const sold = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: { creatorId: req.creatorId, status: { notIn: ["cancelled", "pending_payment"] } },
    _sum: { quantity: true },
  });
  const sales = new Map(sold.map((row) => [row.productId, row._sum.quantity ?? 0]));
  const rows = works.map((work) => ({
    id: work.id,
    title: work.title,
    status: work.status,
    rating: work.rating,
    reviews: work.reviewCount,
    // Views are a stand-in until a real analytics pipeline exists.
    impliedViews: work.reviewCount * 40 + 120,
    unitsSold: sales.get(work.id) ?? 0,
  }));
  res.json({ works: rows, totalUnits: rows.reduce((sum, row) => sum + row.unitsSold, 0), worksCount: works.length });
});

creatorRouter.get("/earnings", async (req, res) => {
  const ledger = await ledgerFor(req.creatorId!);
  res.json({ rows: ledger!.rows, totals: ledger!.totals, kyc: ledger!.artist.kyc });
});

creatorRouter.get("/payouts", async (req, res) => {
  const ledger = await ledgerFor(req.creatorId!);
  const artist = ledger!.artist;
  res.json({ payouts: ledger!.payouts, totals: ledger!.totals, bank: artist.bank, ifsc: artist.ifsc, kyc: artist.kyc, canRequest: artist.kyc === "verified" && ledger!.totals.withdrawable > 0 });
});

creatorRouter.post("/payouts/request", async (req, res) => {
  const { amount } = parse(z.object({ amount: z.coerce.number().int().min(1).optional() }), req.body ?? {});
  const ledger = await ledgerFor(req.creatorId!);
  const artist = ledger!.artist;
  if (artist.kyc !== "verified") throw forbidden("Payouts wait until KYC is verified");
  const ask = amount ?? ledger!.totals.withdrawable;
  if (ask <= 0 || ask > ledger!.totals.withdrawable) throw badRequest(`You can withdraw up to ₹${ledger!.totals.withdrawable.toLocaleString("en-IN")}`);
  const payout = await prisma.payout.create({ data: { id: uid("PO"), artistId: artist.id, amount: ask } });
  await audit(prisma, artist.name, `Payout requested by ${artist.name} for ₹${ask}`);
  res.status(201).json(payout);
});

// ───────── marketing ─────────

creatorRouter.get("/promotions", async (req, res) => {
  res.json(await prisma.promotion.findMany({ where: { artistId: req.creatorId }, orderBy: { createdAt: "desc" } }));
});

creatorRouter.post("/promotions", async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(30) }), req.body);
  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: req.creatorId } });
  const promotion = await prisma.promotion.create({ data: { id: uid("PR"), artistId: artist.id, days } });
  await audit(prisma, artist.name, `${artist.name} requested a ${days}-day boost`);
  res.status(201).json(promotion);
});

creatorRouter.get("/coupons", async (req, res) => {
  res.json(await prisma.coupon.findMany({ where: { artistId: req.creatorId }, orderBy: { createdAt: "desc" } }));
});

creatorRouter.post("/coupons", async (req, res) => {
  const body = parse(
    z.object({
      code: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{3,20}$/, "Use 3–20 letters or digits")),
      value: z.coerce.number().int().min(1).max(30).default(10),
      min: z.coerce.number().int().min(0).default(999),
      usageLimit: z.coerce.number().int().min(1).optional(),
    }),
    req.body,
  );
  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: req.creatorId } });
  if (await prisma.coupon.findFirst({ where: { code: { equals: body.code, mode: "insensitive" } } })) throw conflict("That code already exists");
  res.status(201).json(
    await prisma.coupon.create({ data: { code: body.code, label: `${artist.name} referral`, kind: "percent", value: body.value, min: body.min, usageLimit: body.usageLimit, artistId: artist.id } }),
  );
});

creatorRouter.delete("/coupons/:code", async (req, res) => {
  const coupon = await prisma.coupon.findFirst({ where: { code: param(req, "code"), artistId: req.creatorId } });
  if (!coupon) throw notFound("Coupon not found");
  if (coupon.used > 0) await prisma.coupon.update({ where: { code: coupon.code }, data: { active: false } });
  else await prisma.coupon.delete({ where: { code: coupon.code } });
  res.status(204).end();
});

creatorRouter.get("/reviews", async (req, res) => {
  const rows = await prisma.review.findMany({ where: { product: { artistId: req.creatorId } }, include: { product: { select: { title: true, slug: true } } }, orderBy: { createdAt: "desc" } });
  res.json(rows.map(({ ownerId: _o, ...row }) => row));
});

// ───────── support ─────────

creatorRouter.get("/support", async (req, res) => {
  res.json(await prisma.ticket.findMany({ where: { ownerId: `creator:${req.creatorId}` }, orderBy: { createdAt: "desc" } }));
});

creatorRouter.post("/support", async (req, res) => {
  const body = parse(z.object({ subject: z.string().min(2).max(160).default("Creator help"), body: z.string().min(2).max(4000) }), req.body);
  const artist = await prisma.artist.findUniqueOrThrow({ where: { id: req.creatorId } });
  res.status(201).json(
    await prisma.ticket.create({ data: { id: uid("T"), ownerId: `creator:${artist.id}`, from: artist.name, subject: body.subject, body: body.body, channel: "Creator studio", source: "creator" } }),
  );
});

// ───────── commissions ─────────

creatorRouter.get("/commissions", async (req, res) => {
  res.json(await prisma.commission.findMany({ where: { artistId: req.creatorId }, orderBy: { createdAt: "desc" } }));
});

creatorRouter.post("/commissions/:id/quote", async (req, res) => {
  const quote = parse(z.object({ price: z.coerce.number().int().min(1000), timeline: z.string().min(1).max(60), revisions: z.coerce.number().int().min(0).max(10).default(2) }), req.body);
  res.json(await commissions.sendQuote(param(req, "id"), req.creatorId!, quote));
});

creatorRouter.post("/commissions/:id/decline", async (req, res) => res.json(await commissions.creatorDecline(param(req, "id"), req.creatorId!)));

creatorRouter.post("/commissions/:id/progress", async (req, res) => {
  const { text } = parse(z.object({ text: z.string().min(1).max(1000) }), req.body);
  res.json(await commissions.postProgress(param(req, "id"), req.creatorId!, text));
});

creatorRouter.post("/commissions/:id/dispatch", async (req, res) => res.json(await commissions.dispatch(param(req, "id"), req.creatorId!)));

creatorRouter.post("/commissions/:id/messages", async (req, res) => {
  const { message } = parse(z.object({ message: z.string().min(1).max(1000) }), req.body);
  res.json(await commissions.message(param(req, "id"), null, req.creatorId!, message));
});
