import { Router } from "express";
import { z } from "zod";
import { json, prisma } from "../lib/db";
import { badRequest, conflict, forbidden, notFound, param, parse, uid } from "../lib/http";
import { actorLabel, ADMIN_ROLES, canAccess, needAdmin, staffGate } from "../lib/identity";
import { audit } from "../services/audit";
import { ledgerFor, creatorShare } from "../services/earnings";
import { setJobStatus } from "../services/jobs";
import { cancelOrder, getOrder, markDelivered, recordPayment } from "../services/orders";
import { loadConfig } from "../services/pricing";
import { decideReturn, RETURN_DECISIONS } from "../services/returns";

export const adminRouter = Router();
adminRouter.use(staffGate);

const DESKS = [
  "", "customers", "creators", "moderation", "catalogue", "products", "pricing", "orders", "print-jobs", "shipping", "returns", "payments", "payouts",
  "finance", "cms", "promotions", "reviews", "support", "copyright", "fraud", "b2b", "roles", "audit", "settings", "analytics", "commissions", "gift-cards",
];

const page = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });
const COUNTED = { notIn: ["cancelled", "pending_payment", "refunded"] };

adminRouter.get("/me", needAdmin(""), (req, res) => {
  res.json({ role: req.adminRole, name: req.adminName ?? null, desks: DESKS.filter((desk) => canAccess(req.adminRole!, desk)) });
});

export async function grossMerchandiseValue() {
  const items = await prisma.orderItem.findMany({
    where: { status: COUNTED, order: { paymentStatus: { in: ["paid", "cod"] } } },
    select: { unitPrice: true, quantity: true },
  });
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

adminRouter.get("/dashboard", needAdmin(""), async (_req, res) => {
  const [gmv, orders, returns, queue, moderation, tickets, kyc, payouts] = await Promise.all([
    grossMerchandiseValue(),
    prisma.order.count(),
    prisma.returns.count({ where: { status: { notIn: ["refunded", "closed", "rejected"] } } }),
    prisma.printJob.count({ where: { status: { notIn: ["dispatched", "cancelled", "reprint"] } } }),
    prisma.product.count({ where: { status: "submitted" } }),
    prisma.ticket.count({ where: { status: { not: "resolved" } } }),
    prisma.artist.count({ where: { kyc: "pending" } }),
    prisma.payout.count({ where: { status: "requested" } }),
  ]);
  res.json({ gmv, orders, openReturns: returns, printQueue: queue, awaitingModeration: moderation, openTickets: tickets, pendingKyc: kyc, payoutRequests: payouts });
});

// ───────── customers and fraud ─────────

adminRouter.get("/customers", needAdmin("customers"), async (req, res) => {
  const { q } = parse(z.object({ q: z.string().optional() }), req.query);
  const customers = await prisma.customer.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] } : {},
    orderBy: { createdAt: "desc" },
  });
  const orders = await prisma.order.groupBy({ by: ["customerId"], _count: { _all: true }, _sum: { payable: true } });
  const stats = new Map(orders.map((row) => [row.customerId, row]));
  res.json(customers.map((c) => ({ ...c, orders: stats.get(c.id)?._count._all ?? 0, spend: stats.get(c.id)?._sum.payable ?? 0 })));
});

adminRouter.get("/customers/:id", needAdmin("customers"), async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: param(req, "id") } });
  if (!customer) throw notFound("Customer not found");
  const [orders, returns, tickets] = await Promise.all([
    prisma.order.findMany({ where: { customerId: customer.id }, include: { items: true }, orderBy: { createdAt: "desc" } }),
    prisma.returns.findMany({ where: { order: { customerId: customer.id } } }),
    prisma.ticket.findMany({ where: { ownerId: customer.id } }),
  ]);
  res.json({ ...customer, orders, returns, tickets });
});

adminRouter.post("/customers/:id/credit", needAdmin("finance"), async (req, res) => {
  const { delta, reason } = parse(z.object({ delta: z.coerce.number().int().min(-100000).max(100000).refine((v) => v !== 0), reason: z.string().min(3).max(200) }), req.body);
  const customer = await prisma.customer.findUnique({ where: { id: param(req, "id") } });
  if (!customer) throw notFound("Customer not found");
  if (customer.credit + delta < 0) throw badRequest("Credit cannot go below zero");
  const updated = await prisma.customer.update({ where: { id: customer.id }, data: { credit: { increment: delta } } });
  await audit(prisma, actorLabel(req), `Adjusted store credit for ${customer.name} by ₹${delta}: ${reason}`);
  res.json(updated);
});

adminRouter.get("/fraud", needAdmin("fraud"), async (_req, res) => {
  const [flagged, failed] = await Promise.all([
    prisma.customer.findMany({ where: { risk: { not: null } } }),
    prisma.order.findMany({ where: { paymentStatus: "failed" }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, customerId: true, customerName: true, payable: true, paymentMethod: true } }),
  ]);
  res.json({ flagged, failedPayments: failed });
});

adminRouter.post("/fraud/:customerId", needAdmin("fraud"), async (req, res) => {
  const { risk } = parse(z.object({ risk: z.string().min(2).max(200).nullable() }), req.body);
  const customer = await prisma.customer.update({ where: { id: param(req, "customerId") }, data: { risk } });
  await audit(prisma, actorLabel(req), risk ? `Flagged ${customer.name}: ${risk}` : `Cleared risk flag on ${customer.name}`);
  res.json(customer);
});

// ───────── creators ─────────

adminRouter.get("/creators", needAdmin("creators"), async (req, res) => {
  const showBank = req.adminRole === "super" || req.adminRole === "finance";
  const artists = await prisma.artist.findMany({ orderBy: { name: "asc" } });
  res.json(artists.map((a) => (showBank ? a : { ...a, pan: "Hidden for this role", bank: "Hidden for this role", ifsc: "Hidden for this role" })));
});

adminRouter.post("/creators/:id/kyc", needAdmin("creators"), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["verified", "pending", "expired"]) }), req.body);
  const artist = await prisma.artist.update({ where: { id: param(req, "id") }, data: { kyc: status, verified: status === "verified" ? true : undefined } });
  await audit(prisma, actorLabel(req), `KYC for ${artist.name} set to ${status}`);
  res.json(artist);
});

adminRouter.post("/creators/:id/suspend", needAdmin("creators"), async (req, res) => {
  const { suspended } = parse(z.object({ suspended: z.boolean() }), req.body);
  const artist = await prisma.artist.update({ where: { id: param(req, "id") }, data: { suspended } });
  await audit(prisma, actorLabel(req), `${suspended ? "Suspended" : "Reinstated"} studio ${artist.name}`);
  res.json(artist);
});

adminRouter.patch("/creators/:id/rates", needAdmin("creators"), async (req, res) => {
  if (req.adminRole !== "super" && req.adminRole !== "finance") throw forbidden("Only super or finance can change rates");
  const body = parse(z.object({ royaltyRate: z.coerce.number().min(0).max(0.9).optional(), commissionRate: z.coerce.number().min(0).max(0.9).optional() }), req.body);
  const artist = await prisma.artist.update({ where: { id: param(req, "id") }, data: body });
  await audit(prisma, actorLabel(req), `Updated rates for ${artist.name}: royalty ${artist.royaltyRate}, commission ${artist.commissionRate}`);
  res.json(artist);
});

// ───────── moderation and copyright ─────────

adminRouter.get("/moderation", needAdmin("moderation"), async (req, res) => {
  const { status } = parse(z.object({ status: z.string().optional() }), req.query);
  res.json(
    await prisma.product.findMany({
      where: status ? { status } : { status: { not: "approved" } },
      include: { artist: { select: { id: true, name: true, kyc: true } } },
      orderBy: { updatedAt: "desc" },
    }),
  );
});

adminRouter.post("/products/:id/decision", needAdmin("moderation"), async (req, res) => {
  const body = parse(z.object({ decision: z.enum(["approve", "changes", "reject", "suspend"]), note: z.string().max(500).optional() }), req.body);
  if (body.decision !== "approve" && !body.note?.trim()) throw badRequest("A note is needed so the creator knows why");
  const status = { approve: "approved", changes: "changes_required", reject: "rejected", suspend: "suspended" }[body.decision];
  const product = await prisma.product.update({ where: { id: param(req, "id") }, data: { status, moderatorNote: body.decision === "approve" ? null : body.note } });
  await audit(prisma, actorLabel(req), `${status.replaceAll("_", " ")}: ${product.title}`);
  res.json(product);
});

adminRouter.get("/copyright", needAdmin("copyright"), async (_req, res) => {
  const works = await prisma.product.findMany({ include: { artist: { select: { name: true } } } });
  res.json(works.filter((w) => !w.tags.includes("rights-declared") || w.status === "changes_required").map((w) => ({ ...w, note: w.moderatorNote ?? "Rights note missing" })));
});

adminRouter.post("/copyright/:id/takedown", needAdmin("copyright"), async (req, res) => {
  const { note } = parse(z.object({ note: z.string().min(3).max(500) }), req.body);
  const product = await prisma.product.update({ where: { id: param(req, "id") }, data: { status: "suspended", moderatorNote: note } });
  await audit(prisma, actorLabel(req), `Copyright takedown on ${product.title}: ${note}`);
  res.json(product);
});

// ───────── catalogue and pricing ─────────

const sizes = z.array(z.object({ id: z.string().min(1), label: z.string().min(1), cm: z.string(), price: z.coerce.number().int().min(0) })).min(1);
const materials = z.array(z.object({ id: z.string().min(1), label: z.string().min(1), multiplier: z.coerce.number().min(0.1).max(10) })).min(1);
const frames = z.array(z.object({ id: z.string().min(1), label: z.string().min(1), price: z.coerce.number().int().min(0), swatch: z.string().default("#cccccc") })).min(1)
  .refine((list) => list.some((f) => f.id === "none"), "Keep an Unframed option with id none");
const unique = (list: { id: string }[]) => new Set(list.map((item) => item.id)).size === list.length;

const catalogueBody = z.object({ sizes: sizes.optional(), materials: materials.optional(), frames: frames.optional(), colours: z.array(z.string().min(1)).optional(), rooms: z.array(z.string().min(1)).optional() });
const pricingBody = z.object({
  taxRate: z.coerce.number().min(0).max(0.5).optional(),
  freeShippingOver: z.coerce.number().int().min(0).optional(),
  standardShipping: z.coerce.number().int().min(0).optional(),
  expressShipping: z.coerce.number().int().min(0).optional(),
  codLimit: z.coerce.number().int().min(0).optional(),
  personalizationFee: z.coerce.number().int().min(0).optional(),
  sizes: sizes.optional(),
  materials: materials.optional(),
  frames: frames.optional(),
});

async function saveConfig(req: Parameters<typeof actorLabel>[0], body: z.infer<typeof catalogueBody> & z.infer<typeof pricingBody>, what: string) {
  for (const list of [body.sizes, body.materials, body.frames]) if (list && !unique(list)) throw badRequest("Option ids must be unique");
  const { sizes: s, materials: m, frames: f, ...rest } = body;
  const config = await prisma.config.update({
    where: { id: 1 },
    data: { ...rest, ...(s ? { sizes: json(s) } : {}), ...(m ? { materials: json(m) } : {}), ...(f ? { frames: json(f) } : {}) },
  });
  await audit(prisma, actorLabel(req), what);
  return config;
}

adminRouter.get("/catalogue", needAdmin("catalogue"), async (_req, res) => {
  const { capacity: _c, holidays: _h, partnerName: _p, ...rest } = await loadConfig();
  res.json(rest);
});
adminRouter.put("/catalogue", needAdmin("catalogue"), async (req, res) => res.json(await saveConfig(req, parse(catalogueBody, req.body), "Updated catalogue options")));
adminRouter.get("/pricing", needAdmin("pricing"), async (_req, res) => res.json(await loadConfig()));
adminRouter.put("/pricing", needAdmin("pricing"), async (req, res) => res.json(await saveConfig(req, parse(pricingBody, req.body), "Updated pricing configuration")));

// ───────── orders, print jobs, shipping ─────────

adminRouter.get("/orders", needAdmin("orders"), async (req, res) => {
  const query = parse(page.extend({ q: z.string().optional(), payment: z.string().optional(), status: z.string().optional() }), req.query);
  const where = {
    ...(query.payment ? { paymentStatus: query.payment } : {}),
    ...(query.status ? { items: { some: { status: query.status } } } : {}),
    ...(query.q ? { OR: [{ id: { contains: query.q, mode: "insensitive" as const } }, { customerName: { contains: query.q, mode: "insensitive" as const } }, { email: { contains: query.q, mode: "insensitive" as const } }] } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, include: { items: true }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
  ]);
  res.json({ total, page: query.page, limit: query.limit, items });
});

adminRouter.get("/orders/:id", needAdmin("orders"), async (req, res) => res.json(await getOrder(param(req, "id"))));

adminRouter.post("/orders/:id/cancel", needAdmin("orders"), async (req, res) => {
  const order = await cancelOrder(param(req, "id"));
  await audit(prisma, actorLabel(req), `Cancelled ${order.id}`);
  res.json(order);
});

adminRouter.post("/orders/:id/items/:itemId/delivered", needAdmin("shipping"), async (req, res) => {
  const order = await markDelivered(param(req, "id"), param(req, "itemId"));
  await audit(prisma, actorLabel(req), `Marked a line on ${order.id} delivered`);
  res.json(order);
});

adminRouter.get("/print-jobs", needAdmin("print-jobs"), async (req, res) => {
  const { status } = parse(z.object({ status: z.string().optional() }), req.query);
  res.json(await prisma.printJob.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" } }));
});

adminRouter.post("/print-jobs/:id/status", needAdmin("print-jobs"), async (req, res) => {
  const body = parse(z.object({ status: z.string(), defect: z.string().max(200).optional(), awb: z.string().max(40).optional() }), req.body);
  const job = await setJobStatus(param(req, "id"), body.status, body);
  await audit(prisma, actorLabel(req), `Job ${job.id} set to ${body.status}`);
  res.json(job);
});

adminRouter.get("/shipping", needAdmin("shipping"), async (_req, res) => {
  res.json(await prisma.printJob.findMany({ where: { OR: [{ awb: { not: null } }, { status: { in: ["dispatched", "ready"] } }] }, orderBy: { createdAt: "desc" } }));
});

adminRouter.post("/shipping/:jobId/ndr", needAdmin("shipping"), async (req, res) => {
  const body = parse(z.object({ state: z.enum(["clear", "ndr", "rto"]), note: z.string().max(300).optional() }), req.body);
  const job = await prisma.printJob.update({ where: { id: param(req, "jobId") }, data: { ndr: body.state, ndrNote: body.note } });
  await audit(prisma, actorLabel(req), `Shipment ${job.awb ?? job.id} marked ${body.state}`);
  res.json(job);
});

adminRouter.post("/shipping/:jobId/awb", needAdmin("shipping"), async (req, res) => {
  const { awb } = parse(z.object({ awb: z.string().min(4).max(40) }), req.body);
  const job = await prisma.printJob.update({ where: { id: param(req, "jobId") }, data: { awb } });
  await prisma.orderItem.updateMany({ where: { id: job.itemId }, data: { awb } });
  res.json(job);
});

// ───────── returns ─────────

adminRouter.get("/returns", needAdmin("returns"), async (req, res) => {
  const { status } = parse(z.object({ status: z.string().optional() }), req.query);
  res.json(await prisma.returns.findMany({ where: status ? { status } : {}, include: { order: { select: { id: true, customerName: true, paymentMethod: true } } }, orderBy: { createdAt: "desc" } }));
});

adminRouter.post("/returns/:id/decide", needAdmin("returns"), async (req, res) => {
  const { decision } = parse(z.object({ decision: z.enum(RETURN_DECISIONS) }), req.body);
  const result = await decideReturn(param(req, "id"), decision);
  await audit(prisma, actorLabel(req), `Return ${result.id} marked ${decision}`);
  res.json(result);
});

// ───────── payments, payouts, finance ─────────

adminRouter.get("/payments", needAdmin("payments"), async (req, res) => {
  const query = parse(page.extend({ status: z.string().optional() }), req.query);
  const where = query.status ? { paymentStatus: query.status } : {};
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      select: { id: true, customerName: true, paymentMethod: true, paymentStatus: true, payable: true, refunded: true, giftCardAmount: true, creditUsed: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);
  res.json({ total, page: query.page, limit: query.limit, items: rows });
});

// Manual reconciliation when the gateway outcome is known out of band.
adminRouter.post("/payments/:orderId/status", needAdmin("payments"), async (req, res) => {
  const { result } = parse(z.object({ result: z.enum(["paid", "failed"]) }), req.body);
  const order = await recordPayment(param(req, "orderId"), result);
  await audit(prisma, actorLabel(req), `Payment on ${order.id} reconciled as ${result}`);
  res.json(order);
});

adminRouter.post("/payments/:orderId/refund", needAdmin("payments"), async (req, res) => {
  const { amount, reason } = parse(z.object({ amount: z.coerce.number().int().min(1), reason: z.string().min(3).max(200) }), req.body);
  const order = await prisma.order.findUnique({ where: { id: param(req, "orderId") } });
  if (!order) throw notFound("Order not found");
  if (!["paid", "refunded"].includes(order.paymentStatus)) throw conflict("Only paid orders can be refunded");
  if (order.refunded + amount > order.payable) throw badRequest(`At most ₹${order.payable - order.refunded} can still be refunded`);
  const total = order.refunded + amount;
  const updated = await prisma.order.update({ where: { id: order.id }, data: { refunded: total, paymentStatus: total >= order.payable ? "refunded" : order.paymentStatus } });
  await audit(prisma, actorLabel(req), `Refunded ₹${amount} on ${order.id}: ${reason}`);
  res.json(updated);
});

adminRouter.get("/payouts", needAdmin("payouts"), async (_req, res) => {
  const artists = await prisma.artist.findMany({ orderBy: { name: "asc" } });
  const rows = await Promise.all(
    artists.map(async (artist) => {
      const ledger = await ledgerFor(artist.id);
      return { artistId: artist.id, name: artist.name, kyc: artist.kyc, bank: artist.bank, ifsc: artist.ifsc, totals: ledger!.totals };
    }),
  );
  const requests = await prisma.payout.findMany({ where: { status: "requested" }, include: { artist: { select: { name: true, kyc: true, bank: true } } }, orderBy: { requestedAt: "asc" } });
  res.json({ artists: rows, requests });
});

adminRouter.post("/payouts/:id/release", needAdmin("payouts"), async (req, res) => {
  const payout = await prisma.payout.findUnique({ where: { id: param(req, "id") }, include: { artist: true } });
  if (!payout) throw notFound("Payout not found");
  if (payout.status !== "requested") throw conflict(`Payout is already ${payout.status}`);
  if (payout.artist.kyc !== "verified") throw forbidden("KYC is not verified");
  const updated = await prisma.payout.update({ where: { id: payout.id }, data: { status: "released", releasedAt: new Date() } });
  await audit(prisma, actorLabel(req), `Released payout ${payout.id} (₹${payout.amount}) for ${payout.artist.name}`);
  res.json(updated);
});

adminRouter.post("/payouts/:id/reject", needAdmin("payouts"), async (req, res) => {
  const { note } = parse(z.object({ note: z.string().min(3).max(300) }), req.body);
  const payout = await prisma.payout.findUnique({ where: { id: param(req, "id") } });
  if (!payout) throw notFound("Payout not found");
  if (payout.status !== "requested") throw conflict(`Payout is already ${payout.status}`);
  const updated = await prisma.payout.update({ where: { id: payout.id }, data: { status: "rejected", note } });
  await audit(prisma, actorLabel(req), `Rejected payout ${payout.id}: ${note}`);
  res.json(updated);
});

// Releases everything currently withdrawable for one studio in a single batch.
adminRouter.post("/payouts/artists/:artistId/release", needAdmin("payouts"), async (req, res) => {
  const ledger = await ledgerFor(param(req, "artistId"));
  if (!ledger) throw notFound("Artist not found");
  if (ledger.artist.kyc !== "verified") throw forbidden("KYC is not verified");
  if (ledger.totals.withdrawable <= 0) throw conflict("Nothing is available to release");
  const payout = await prisma.payout.create({ data: { id: uid("PB"), artistId: ledger.artist.id, amount: ledger.totals.withdrawable, status: "released", releasedAt: new Date() } });
  await audit(prisma, actorLabel(req), `Released payout batch ${payout.id} for ${ledger.artist.name}`);
  res.status(201).json(payout);
});

async function financeNumbers() {
  const [gmv, artists, items, cards, customers, orders] = await Promise.all([
    grossMerchandiseValue(),
    prisma.artist.findMany(),
    prisma.orderItem.findMany({ where: { status: COUNTED, order: { paymentStatus: { in: ["paid", "cod"] } } } }),
    prisma.giftCard.findMany({ where: { status: { in: ["active", "scheduled"] } } }),
    prisma.customer.aggregate({ _sum: { credit: true } }),
    prisma.order.aggregate({ where: { paymentStatus: { in: ["paid", "cod", "refunded"] } }, _sum: { refunded: true, gst: true, discount: true, shipping: true } }),
  ]);
  const byArtist = new Map(artists.map((a) => [a.id, a]));
  const creatorPayable = items.reduce((sum, item) => {
    const artist = item.creatorId ? byArtist.get(item.creatorId) : undefined;
    return artist ? sum + creatorShare(item, artist) : sum;
  }, 0);
  const released = await prisma.payout.aggregate({ where: { status: "released" }, _sum: { amount: true } });
  return {
    gmv,
    creatorPayable,
    platformRevenue: gmv - creatorPayable,
    paidOutToCreators: released._sum.amount ?? 0,
    giftCardLiability: cards.reduce((sum, card) => sum + card.balance, 0),
    storeCreditLiability: customers._sum.credit ?? 0,
    refunds: orders._sum.refunded ?? 0,
    gstCollected: orders._sum.gst ?? 0,
    discountsGiven: orders._sum.discount ?? 0,
    shippingCharged: orders._sum.shipping ?? 0,
  };
}

adminRouter.get("/finance", needAdmin("finance"), async (_req, res) => res.json(await financeNumbers()));

adminRouter.get("/finance/orders.csv", needAdmin("finance"), async (_req, res) => {
  const orders = await prisma.order.findMany({ orderBy: { createdAt: "asc" } });
  const header = "order_id,placed_at,customer,payment_method,payment_status,subtotal,discount,shipping,gst_included,payable,refunded";
  const cell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const lines = orders.map((o) => [o.id, o.placedAt, o.customerName, o.paymentMethod, o.paymentStatus, o.subtotal, o.discount, o.shipping, o.gst, o.payable, o.refunded].map(cell).join(","));
  res.type("text/csv").send([header, ...lines].join("\n"));
});

export { ADMIN_ROLES };
