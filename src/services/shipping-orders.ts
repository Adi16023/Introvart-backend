import { z } from "zod";
import { prisma, json } from "../lib/db";
import { conflict, notFound, HttpError } from "../lib/http";
import { PRESS_TYPES, SELLER_TYPES } from "./pricing";
import { shipmentView, warehouseOwner } from "./shipping";
import { packageSchema, rateBody, ratesSchema, remoteBookingSchema, remoteListResultSchema, velocityRequest } from "./velocity";

export const orderTabs = ["new", "ready", "transit", "delivered", "attention", "rto", "cancelled", "all"] as const;
export type OrderTab = typeof orderTabs[number];

export function orderTab(status: string, state = ""): OrderTab {
  if (state === "cancelled" || ["cancelled", "refunded"].includes(status)) return "cancelled";
  if (state === "attention" || state === "cancel_requested" || ["ndr_raised", "lost", "damaged", "need_attention", "needs_attention"].includes(status)) return "attention";
  if (status.startsWith("rto")) return "rto";
  if (status === "delivered") return "delivered";
  if (["in_transit", "out_for_delivery", "shipped", "dispatched"].includes(status)) return "transit";
  if (status === "ready_for_pickup" || state === "booked") return "ready";
  return "new";
}

export async function localShippingOrders() {
  const items = await prisma.orderItem.findMany({
    where: { fulfilment: { in: [...PRESS_TYPES, ...SELLER_TYPES] }, order: { settled: true } },
    include: { order: { include: { shipments: { where: { journey: "forward" }, orderBy: { createdAt: "desc" } }, jobs: { orderBy: { createdAt: "desc" } } } } },
    orderBy: { order: { createdAt: "desc" } },
  });
  const variants = await prisma.productVariant.findMany({ where: { id: { in: items.flatMap(item => item.variantId ? [item.variantId] : []) } } });
  const warehouses = await prisma.shippingWarehouse.findMany();
  return items.map(item => {
    const order = item.order;
    const jobs = order.jobs.filter(job => job.itemId === item.id && !["cancelled", "reprint"].includes(job.status));
    const job = jobs[0];
    const shipment = order.shipments.find(entry => entry.itemId === item.id && (job ? entry.jobId === job.id : !entry.jobId));
    const owner = !PRESS_TYPES.includes(item.fulfilment) && !item.creatorId ? null : warehouseOwner(item);
    const warehouse = warehouses.find(entry => entry.owner === owner);
    const variant = variants.find(entry => entry.id === item.variantId);
    const address = z.object({ name: z.string().optional(), phone: z.string().optional(), line: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional() }).passthrough().safeParse(order.address);
    const status = ["cancelled", "refunded"].includes(item.status) ? item.status
      : shipment?.status ?? (job && job.status !== "dispatched" ? "pending" : item.status);
    const ready = Boolean(owner) && !order.shippingBlocked && ["paid", "cod"].includes(order.paymentStatus) && !["cancelled", "refunded", "return_requested"].includes(item.status)
      && (PRESS_TYPES.includes(item.fulfilment) ? Boolean(job && ["new", "ready"].includes(job.status)) : ["confirmed", "accepted"].includes(item.status));
    return {
      id: item.id, orderId: order.id, itemId: item.id, jobId: job?.id ?? null,
      title: item.title, quantity: item.quantity, createdAt: order.createdAt,
      customer: address.success ? { ...address.data, name: address.data.name || order.customerName } : { name: order.customerName },
      paymentStatus: order.paymentStatus, amount: item.unitPrice * item.quantity,
      warehouse: warehouse ?? null, status, tab: orderTab(status, shipment?.state),
      ready: Boolean(ready && (!shipment || shipment.state === "cancelled")), productionStatus: job?.status ?? item.status,
      shipment: shipment ? shipmentView(shipment) : null,
      shipments: order.shipments.filter(entry => entry.itemId === item.id).map(shipmentView),
      parcel: shipment ? { length: shipment.length, width: shipment.width, height: shipment.height, weightGrams: shipment.weightGrams }
        : variant ? { length: variant.packedLength, width: variant.packedWidth, height: variant.packedHeight, weightGrams: variant.grams, dimensionUnit: variant.packedDimensionUnit } : null,
    };
  });
}

export async function remoteShippingOrder(id: string, lookup: string) {
  const response = await velocityRequest("shipments", { page: 1, per_page: 100, search: lookup }, remoteListResultSchema);
  const record = response.data.find(entry => entry.id === id);
  if (!record) throw notFound("Velocity shipment not found. Refresh the list before proceeding.");
  return record;
}

const remoteAddress = z.object({ zip: z.string().regex(/^[1-9][0-9]{5}$/) }).passthrough();
export function remoteRateBody(attributes: Record<string, unknown>, parcel: z.infer<typeof packageSchema>) {
  const origin = remoteAddress.safeParse(attributes.pickup_details);
  const destination = remoteAddress.safeParse(attributes.shipping_address);
  const payment = z.object({ is_cod: z.boolean(), cod_amount: z.coerce.number().finite().nonnegative() }).safeParse(attributes);
  if (!origin.success || !destination.success || !payment.success) throw conflict("Velocity did not provide the pickup, destination or payment details. Resolve the order in Velocity before shipping.");
  const weight = z.object({ value: z.number().finite().nonnegative(), metric_unit: z.enum(["g", "kg"]) }).safeParse(attributes.weight);
  if (weight.success && weight.data.value > 0) {
    const grams = weight.data.value * (weight.data.metric_unit === "kg" ? 1000 : 1);
    if (Math.abs(grams - parcel.weightGrams) > 0.01) throw conflict("Packed weight differs from the weight saved in Velocity. Update the remote package in Velocity before quoting or assigning.");
  }
  return rateBody(parcel, origin.data.zip, destination.data.zip, "forward", payment.data.is_cod ? payment.data.cod_amount : 0);
}

export async function quoteRemoteOrder(id: string, parcel: z.infer<typeof packageSchema>, lookup: string) {
  const record = await remoteShippingOrder(id, lookup);
  return (await velocityRequest("rates", remoteRateBody(record.attributes, parcel), ratesSchema)).result;
}

export async function assignRemoteOrder(id: string, carrierId: string, parcel: z.infer<typeof packageSchema>, lookup: string) {
  const previous = await prisma.velocityAssignment.findUnique({ where: { shipmentId: id } });
  if (previous) throw conflict(`This shipment already has an ${previous.state} assignment attempt${previous.awb ? ` (AWB ${previous.awb})` : ""}. Reconcile in Velocity before retrying.`);
  const linked = await prisma.shippingShipment.findFirst({ where: { remoteShipmentId: id } });
  if (linked) throw conflict("This shipment belongs to Introvart. Assign it from the Introvart view to preserve fulfilment checks.");
  const record = await remoteShippingOrder(id, lookup);
  if (!["new", "pending"].includes(String(record.attributes.status)) || record.attributes.tracking_number) throw conflict("Only a new, unassigned Velocity shipment can be shipped.");
  const quote = (await velocityRequest("rates", remoteRateBody(record.attributes, parcel), ratesSchema)).result;
  if (!quote.serviceable_couriers.some(entry => entry.carrier_id === carrierId)) throw conflict("Select an available courier for this parcel.");
  // The primary key persists the claim before the non-idempotent remote assignment.
  const claim = await prisma.velocityAssignment.createMany({ data: [{ shipmentId: id, carrierId, state: "assigning" }], skipDuplicates: true });
  if (!claim.count) throw conflict("Courier assignment is already in progress. Reconcile before retrying.");
  try {
    const response = await velocityRequest("forward-order-shipment", { shipment_id: id, carrier_id: carrierId }, remoteBookingSchema);
    if (!response.payload.awb_code) throw new HttpError(502, "Velocity did not return an AWB. Reconcile before retrying.");
    await prisma.velocityAssignment.update({ where: { shipmentId: id }, data: { state: "booked", awb: response.payload.awb_code, result: json(response.payload) } });
    return response.payload;
  } catch (error) {
    await prisma.velocityAssignment.update({ where: { shipmentId: id }, data: { state: "attention", error: error instanceof Error ? error.message : "Velocity assignment failed." } });
    throw error;
  }
}
