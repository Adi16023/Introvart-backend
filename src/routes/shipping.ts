import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { badRequest, forbidden, param, parse } from "../lib/http";
import { canAccess, needCreator, staffGate } from "../lib/identity";
import { audit } from "../services/audit";
import {
  bookingSchema, bookShipment, cancelShipment, findShipment, quoteShipment,
  refreshShipment, saveWarehouse, shipmentView, warehouseSchema,
  shippingLabel, assignShipment, cancelAwbs,
} from "../services/shipping";
import {
  velocityConfigured, velocityRequest, serviceabilitySchema, serviceabilityResultSchema,
  laneRateSchema, packageSchema, rateBody, ratesSchema, forwardFilterSchema, returnFilterSchema, remoteListResultSchema,
} from "../services/velocity";
import { assignRemoteOrder, localShippingOrders, orderTabs, quoteRemoteOrder } from "../services/shipping-orders";
import { env } from "../lib/env";
import { PRESS_TYPES, SELLER_TYPES } from "../services/pricing";

export const shippingRouter = Router();
shippingRouter.use(staffGate, (req, res, next) => {
  if (!req.adminRole) return void needCreator(req, res, next);
  if (!canAccess(req.adminRole, "shipping") && !canAccess(req.adminRole, "returns")) return next(forbidden("Shipping access required"));
  next();
});

function permission(req: Request, journey: string) {
  if (!req.adminRole) {
    if (journey !== "forward") throw forbidden("Return pickups must be approved and booked by operations or support.");
    return;
  }
  if (!canAccess(req.adminRole, journey === "return" ? "returns" : "shipping")) throw forbidden("Outside this shipping role");
}
function adminPermission(req: Request, journey: string) {
  if (!req.adminRole) throw forbidden("Account-wide Velocity tools require an admin shipping role.");
  permission(req, journey);
}
const actor = (req: Request) => req.adminRole ? {} : { creatorId: req.creatorId! };
const ownerSchema = z.string().regex(/^(platform|creator:[A-Za-z0-9_-]+)$/);
function owner(req: Request) {
  const result = req.adminRole ? parse(ownerSchema, req.query.owner ?? req.body?.owner ?? "platform") : `creator:${req.creatorId}`;
  return result;
}

shippingRouter.get("/config", async (req, res) => {
  res.json({
    configured: velocityConfigured(), environment: env.velocity.baseUrl.includes("staging") ? "staging" : "production",
    warehouses: await prisma.shippingWarehouse.findMany({
      where: req.adminRole ? {} : { owner: `creator:${req.creatorId}` }, orderBy: { name: "asc" },
    }),
  });
});

shippingRouter.post("/serviceability", async (req, res) => {
  const input = parse(serviceabilitySchema, req.body);
  adminPermission(req, input.shipment_type);
  res.json(await velocityRequest("serviceability", input, serviceabilityResultSchema));
});

shippingRouter.post("/rates", async (req, res) => {
  const input = parse(laneRateSchema, req.body);
  adminPermission(req, input.journey);
  res.json((await velocityRequest("rates", rateBody(input, input.origin, input.destination, input.journey,
    input.paymentMode === "cod" ? input.codAmount : 0, input.qcApplicable), ratesSchema)).result);
});

shippingRouter.post("/remote/:journey", async (req, res) => {
  const journey = parse(z.enum(["forward", "return"]), param(req, "journey"));
  adminPermission(req, journey);
  const input = journey === "forward" ? parse(forwardFilterSchema, req.body) : parse(returnFilterSchema, req.body);
  res.json(await velocityRequest(journey === "forward" ? "shipments" : "returns", input, remoteListResultSchema));
});

shippingRouter.get("/order-records", async (req, res) => {
  adminPermission(req, "forward");
  const query = parse(z.object({
    page: z.coerce.number().int().min(1).default(1), perPage: z.coerce.number().int().min(1).max(100).default(10),
    tab: z.enum(orderTabs).default("new"), search: z.string().max(200).default(""),
    from: z.iso.datetime().optional(), until: z.iso.datetime().optional(),
    payment: z.enum(["all", "prepaid", "cod"]).default("all"), warehouse: z.string().max(100).default(""),
  }).refine(data => !data.from || !data.until || data.until >= data.from, "End date must be after start date."), req.query);
  const search = query.search.trim().toLowerCase();
  const records = (await localShippingOrders()).filter(record =>
    (!search || [record.orderId, record.title, record.customer.name, record.customer.phone, record.customer.city, record.shipment?.awb].some(value => value?.toLowerCase().includes(search)))
    && (!query.from || record.createdAt >= new Date(query.from)) && (!query.until || record.createdAt <= new Date(query.until))
    && (query.payment === "all" || (query.payment === "cod" ? record.paymentStatus === "cod" : record.paymentStatus === "paid"))
    && (!query.warehouse || record.warehouse?.id === query.warehouse));
  const counts = Object.fromEntries(orderTabs.map(tab => [tab, tab === "all" ? records.length : records.filter(record => record.tab === tab).length]));
  const filtered = records.filter(record => query.tab === "all" || record.tab === query.tab);
  res.json({ items: filtered.slice((query.page - 1) * query.perPage, query.page * query.perPage), total: filtered.length, counts });
});

shippingRouter.post("/order-records/velocity", async (req, res) => {
  adminPermission(req, "forward");
  const input = parse(forwardFilterSchema, req.body);
  const response = await velocityRequest("shipments", input, remoteListResultSchema);
  const ids = response.data.map(record => record.id);
  const [actions, linked] = await Promise.all([
    prisma.velocityAssignment.findMany({ where: { shipmentId: { in: ids } }, select: { shipmentId: true, state: true, awb: true, error: true, result: true } }),
    prisma.shippingShipment.findMany({ where: { remoteShipmentId: { in: ids } }, select: { id: true, remoteShipmentId: true, state: true } }),
  ]);
  res.json({ ...response, data: response.data.map(record => ({ ...record, assignment: actions.find(action => action.shipmentId === record.id) ?? null, linkedShipment: linked.find(shipment => shipment.remoteShipmentId === record.id) ?? null })) });
});

shippingRouter.post("/order-records/velocity/:id/quote", async (req, res) => {
  adminPermission(req, "forward");
  const input = parse(packageSchema.extend({ lookup: z.string().min(1).max(200) }).strict(), req.body);
  res.json(await quoteRemoteOrder(param(req, "id"), input, input.lookup));
});

shippingRouter.post("/order-records/velocity/:id/ship", async (req, res) => {
  adminPermission(req, "forward");
  const input = parse(packageSchema.extend({ lookup: z.string().min(1).max(200), carrierId: z.string().min(1).max(100), packedDetailsConfirmed: z.literal(true) }).strict(), req.body);
  const result = await assignRemoteOrder(param(req, "id"), input.carrierId, input, input.lookup);
  await audit(prisma, req.adminName ?? "Admin", `Assigned existing Velocity shipment ${param(req, "id")}`);
  res.json(result);
});

shippingRouter.post("/tracking", async (req, res) => {
  adminPermission(req, "forward");
  const input = parse(z.object({ awbs: z.array(z.string().min(1).max(100)).min(1).max(50) }).strict(), req.body);
  res.json(await velocityRequest("order-tracking", input, z.object({ result: z.record(z.string(), z.unknown()) })));
});

shippingRouter.post("/cancel", async (req, res) => {
  adminPermission(req, "forward");
  adminPermission(req, "return");
  const input = parse(z.object({ awbs: z.array(z.string().min(1).max(100)).min(1).max(50) }).strict(), req.body);
  const result = await cancelAwbs(input.awbs);
  await audit(prisma, req.adminName ?? "Admin", `Requested Velocity cancellation for ${input.awbs.length} AWBs`);
  res.json(result);
});

shippingRouter.post("/warehouses", async (req, res) => {
  permission(req, "forward");
  const input = parse(warehouseSchema, req.body);
  const warehouseOwner = owner(req);
  if (warehouseOwner.startsWith("creator:")) {
    const artist = await prisma.artist.findUnique({ where: { id: warehouseOwner.slice(8) }, select: { id: true } });
    if (!artist) throw badRequest("Artist not found");
  }
  const result = await saveWarehouse(warehouseOwner, input);
  await audit(prisma, req.adminName ?? `Creator ${req.creatorId}`, `Configured Velocity warehouse ${result.id}`);
  res.status(201).json(result);
});

shippingRouter.get("/queue", async (req, res) => {
  permission(req, "forward");
  const items = await prisma.orderItem.findMany({
    where: {
      fulfilment: { in: req.adminRole ? [...PRESS_TYPES, ...SELLER_TYPES] : SELLER_TYPES },
      ...(req.adminRole ? {} : { creatorId: req.creatorId }),
      status: { notIn: ["pending_payment", "cancelled", "refunded"] },
      order: { settled: true, paymentStatus: { in: ["paid", "cod"] } },
    },
    include: { order: { select: { id: true, createdAt: true, paymentStatus: true } } },
    orderBy: { order: { createdAt: "desc" } }, take: 100,
  });
  const jobs = await prisma.printJob.findMany({ where: { itemId: { in: items.map((item) => item.id) }, status: { notIn: ["cancelled", "reprint"] } }, orderBy: { createdAt: "desc" } });
  const variants = await prisma.productVariant.findMany({ where: { id: { in: items.flatMap((item) => item.variantId ? [item.variantId] : []) } } });
  res.json(items.map((item) => ({
    id: item.id, orderId: item.orderId, title: item.title, quantity: item.quantity,
    fulfilment: item.fulfilment, creatorId: item.creatorId, status: item.status,
    jobs: jobs.filter((job) => job.itemId === item.id).map((job) => ({ id: job.id, status: job.status })),
    package: variants.filter((variant) => variant.id === item.variantId).map((variant) => ({
      weightGrams: variant.grams, length: variant.packedLength, width: variant.packedWidth, height: variant.packedHeight,
      dimensionUnit: variant.packedDimensionUnit,
    }))[0] ?? null,
  })));
});

shippingRouter.get("/returns", async (req, res) => {
  permission(req, "return");
  res.json(await prisma.returns.findMany({
    where: { status: { in: ["opened", "evidence_review", "pickup_approved"] } },
    select: { id: true, orderId: true, itemId: true, itemTitle: true, reason: true, status: true },
    orderBy: { createdAt: "desc" }, take: 100,
  }));
});

shippingRouter.post("/orders/:orderId/quote", async (req, res) => {
  const input = parse(bookingSchema, req.body);
  permission(req, input.returnCaseId ? "return" : "forward");
  res.json(await quoteShipment(param(req, "orderId"), input, actor(req)));
});

shippingRouter.post("/orders/:orderId/book", async (req, res) => {
  const input = parse(bookingSchema, req.body);
  permission(req, input.returnCaseId ? "return" : "forward");
  const result = await bookShipment(param(req, "orderId"), input, { ...actor(req), allowNewOrders: Boolean(req.adminRole) });
  await audit(prisma, req.adminName ?? `Creator ${req.creatorId}`, `Booked Velocity ${result.journey} ${result.id}`);
  res.status(201).json(result);
});

shippingRouter.get("/shipments", async (req, res) => {
  const query = parse(z.object({
    page: z.coerce.number().int().min(1).default(1),
    journey: z.enum(["forward", "return"]).default("forward"),
    search: z.string().max(100).default(""),
  }), req.query);
  permission(req, query.journey);
  const where = {
    journey: query.journey, ...(req.adminRole ? {} : { creatorId: req.creatorId }),
    ...(query.search ? { OR: [{ id: { contains: query.search } }, { orderId: { contains: query.search } }, { awb: { contains: query.search } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.shippingShipment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * 25, take: 25 }),
    prisma.shippingShipment.count({ where }),
  ]);
  res.json({ items: items.map(shipmentView), total, page: query.page });
});

shippingRouter.post("/shipments/:id/refresh", async (req, res) => {
  const shipment = await findShipment(param(req, "id"), actor(req));
  permission(req, shipment.journey);
  res.json(await refreshShipment(shipment.id, actor(req)));
});

shippingRouter.post("/shipments/:id/assign", async (req, res) => {
  const shipment = await findShipment(param(req, "id"), actor(req));
  permission(req, shipment.journey);
  const input = parse(z.object({ carrierId: z.string().max(100).optional() }).strict(), req.body);
  const result = await assignShipment(shipment.id, input.carrierId, actor(req));
  await audit(prisma, req.adminName ?? `Creator ${req.creatorId}`, `Assigned Velocity courier ${shipment.id}`);
  res.json(result);
});

shippingRouter.post("/shipments/:id/cancel", async (req, res) => {
  const shipment = await findShipment(param(req, "id"), actor(req));
  permission(req, shipment.journey);
  const result = await cancelShipment(shipment.id, actor(req));
  await audit(prisma, req.adminName ?? `Creator ${req.creatorId}`, `Requested cancellation of Velocity ${shipment.id}`);
  res.json(result);
});

shippingRouter.post("/shipments/:id/label", async (req, res) => {
  const shipment = await findShipment(param(req, "id"), actor(req));
  permission(req, shipment.journey);
  res.json(await shippingLabel(shipment.id, actor(req)));
});

shippingRouter.post("/reports", async (req, res) => {
  if (!req.adminRole) throw forbidden("Velocity account-wide reports are available only to admin shipping roles.");
  const input = parse(z.object({
    start_date_time: z.iso.datetime(), end_date_time: z.iso.datetime(), shipment_type: z.enum(["forward", "return"]),
  }).refine((data) => new Date(data.end_date_time) >= new Date(data.start_date_time), "End must be after start"), req.body);
  permission(req, input.shipment_type);
  res.json(await velocityRequest("reports", input, z.object({ payload: z.record(z.string(), z.unknown()) })));
});
