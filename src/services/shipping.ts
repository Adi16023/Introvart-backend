import type { Order, OrderItem, ShippingShipment } from "@prisma/client";
import { z } from "zod";
import { json, prisma, transaction } from "../lib/db";
import { badRequest, conflict, HttpError, notFound, uid } from "../lib/http";
import { putObject, signedShippingLabel, sniff } from "../lib/storage";
import { markDelivered } from "./orders";
import { PRESS_TYPES, SELLER_TYPES } from "./pricing";
import { codAllocation, packageSchema, rateBody, ratesSchema, remoteBookingSchema, velocityRequest } from "./velocity";

export const warehouseSchema = z.object({
  velocityId: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(100),
  contactPerson: z.string().min(1).max(80),
  phone: z.string().regex(/^[0-9+\s-]{10,15}$/),
  email: z.string().email(),
  address: z.string().min(3).max(250),
  city: z.string().min(1).max(80),
  state: z.string().min(1).max(80),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/),
  gstNo: z.string().max(30).optional(),
});
export const bookingSchema = packageSchema.extend({
  itemId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  returnCaseId: z.string().min(1).optional(),
  carrierId: z.string().max(100).optional(),
  bookingMode: z.enum(["two_step", "orchestration", "order_only"]).optional(),
  returnQc: z.object({
    productName: z.string().min(1).max(200),
    image: z.string().url().refine((value) => new URL(value).protocol === "https:", "QC image must use HTTPS."),
    brand: z.string().max(100).optional(), configured: z.literal(true),
  }).optional(),
}).refine((data) => !data.returnQc || Boolean(data.returnCaseId), "QC is only available for a return pickup.");
export type BookingInput = z.infer<typeof bookingSchema>;
type ShippingOrder = Order & { items: OrderItem[] };
export type ShippingActor = { creatorId?: string };

const addressSchema = z.object({
  name: z.string().min(1), phone: z.string().min(10), line: z.string().min(3),
  city: z.string().min(1), state: z.string().min(1), pincode: z.string().regex(/^[1-9][0-9]{5}$/),
});
const httpsUrl = (value: string | null | undefined) => {
  if (!value) return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
};

export function warehouseOwner(item: Pick<OrderItem, "fulfilment" | "creatorId">) {
  if (PRESS_TYPES.includes(item.fulfilment)) return "platform";
  if (SELLER_TYPES.includes(item.fulfilment) && item.creatorId) return `creator:${item.creatorId}`;
  throw badRequest("This line has no supported shipping fulfilment. Commission shipping must use its commission workflow.");
}

export async function saveWarehouse(owner: string, input: z.infer<typeof warehouseSchema>) {
  const { gstNo, ...details } = input;
  const existing = await prisma.shippingWarehouse.findUnique({ where: { owner } });
  if (!input.velocityId && existing) throw conflict("This owner already has a warehouse. Supply its existing Velocity ID to edit local details.");
  let velocityId = input.velocityId;
  if (!velocityId) {
    const result = await velocityRequest("warehouse", {
      name: input.name, phone_number: input.phone, email: input.email, contact_person: input.contactPerson, gst_no: gstNo,
      address_attributes: { street_address: input.address, zip: input.pincode, city: input.city, state: input.state, country: "India" },
    }, z.object({ payload: z.object({ warehouse_id: z.string().min(1) }) }));
    velocityId = result.payload.warehouse_id;
  }
  return prisma.shippingWarehouse.upsert({
    where: { owner },
    create: { id: uid("WH"), owner, ...details, velocityId },
    update: { ...details, velocityId },
  });
}

export async function shippingLine(orderId: string, itemId: string, actor: ShippingActor) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  const item = order?.items.find((entry) => entry.id === itemId);
  if (!order || !item || (actor.creatorId && (item.creatorId !== actor.creatorId || !SELLER_TYPES.includes(item.fulfilment)))) {
    throw notFound("Shipping order line not found");
  }
  const owner = warehouseOwner(item);
  const warehouse = await prisma.shippingWarehouse.findUnique({ where: { owner } });
  if (!warehouse) throw conflict(`Set up the ${owner === "platform" ? "platform" : "artist"} pickup warehouse before quoting or booking.`);
  const address = addressSchema.safeParse(order.address);
  if (!address.success) throw badRequest("The order has an incomplete shipping address.");
  return { order, item, warehouse, address: address.data };
}

export async function quoteShipment(orderId: string, input: BookingInput, actor: ShippingActor) {
  const { order, item, warehouse, address } = await shippingLine(orderId, input.itemId, actor);
  const journey = input.returnCaseId ? "return" : "forward";
  const cod = journey === "forward" ? collectibleFor(order, item) : 0;
  return (await velocityRequest("rates", rateBody(
    input, journey === "return" ? address.pincode : warehouse.pincode,
    journey === "return" ? warehouse.pincode : address.pincode, journey, cod, Boolean(input.returnQc),
  ), ratesSchema)).result;
}

function collectibleFor(order: ShippingOrder, item: OrderItem) {
  if (order.paymentStatus !== "cod" || item.deliveredAt) return 0;
  return codAllocation(order.payable, order.items, item.id);
}

function forwardBody(order: ShippingOrder, item: OrderItem, warehouse: { velocityId: string; name: string }, parcel: BookingInput, reference: string, cod: number) {
  const address = addressSchema.parse(order.address);
  return {
    order_id: reference, order_date: new Date().toISOString().slice(0, 16).replace("T", " "),
    billing_customer_name: address.name, billing_address: address.line,
    billing_city: address.city, billing_state: address.state, billing_pincode: address.pincode,
    billing_country: "India", billing_phone: address.phone, billing_email: order.email,
    shipping_is_billing: true, print_label: true,
    order_items: [{ name: item.title, sku: item.sku || item.id, units: item.quantity, selling_price: item.unitPrice, discount: 0, tax: 0 }],
    payment_method: cod > 0 ? "COD" : "PREPAID", cod_collectible: cod,
    sub_total: item.unitPrice * item.quantity,
    length: parcel.length, breadth: parcel.width, height: parcel.height, weight: parcel.weightGrams / 1000,
    pickup_location: warehouse.name, warehouse_id: warehouse.velocityId,
  };
}

export async function bookShipment(orderId: string, input: BookingInput, actor: ShippingActor) {
  const { order, item, warehouse, address } = await shippingLine(orderId, input.itemId, actor);
  if (!order.settled || !["paid", "cod"].includes(order.paymentStatus)) throw conflict("The order must be paid or accepted as COD before shipping.");
  const journey = input.returnCaseId ? "return" : "forward";
  let jobId: string | undefined;
  if (journey === "return") {
    const returned = await prisma.returns.findUnique({ where: { id: input.returnCaseId } });
    if (!returned || returned.orderId !== orderId || returned.itemId !== item.id) throw notFound("Return case not found");
    if (returned.status !== "pickup_approved") throw conflict("Approve the physical return pickup before booking it.");
  } else if (PRESS_TYPES.includes(item.fulfilment)) {
    if (!input.jobId) throw badRequest("Select the ready print job for this shipment.");
    const job = await prisma.printJob.findUnique({ where: { id: input.jobId } });
    if (!job || job.orderId !== orderId || job.itemId !== item.id) throw notFound("Print job not found");
    if (job.status !== "ready") throw conflict("Complete printing, QC and packing and mark this job ready before booking.");
    jobId = job.id;
  } else if (item.status !== "accepted") {
    throw conflict("The artist must accept this order line before booking.");
  }
  if (["cancelled", "refunded", "pending_payment"].includes(item.status) || (journey === "forward" && item.status === "return_requested")) throw conflict("This line cannot be shipped.");
  // Every physical package has one stable reference, including replacement print jobs and approved returns.
  const bookingKey = input.returnCaseId ? `return:${input.returnCaseId}` : jobId ? `job:${jobId}` : `item:${item.id}`;
  const existing = await prisma.shippingShipment.findUnique({ where: { bookingKey } });
  if (existing) {
    if (existing.state === "booked") return shipmentView(existing);
    throw conflict(`Shipment ${existing.id} already exists (${existing.state}). Refresh/reconcile it instead of booking twice.`);
  }
  const quote = await quoteShipment(orderId, input, actor);
  if (!quote.serviceable_couriers.length) throw conflict("No Velocity courier serves this route.");
  if (input.carrierId && !quote.serviceable_couriers.some((courier) => courier.carrier_id === input.carrierId)) {
    throw badRequest("Select a courier from the current quote.");
  }
  const id = uid("SHIP");
  const collectible = journey === "forward" ? collectibleFor(order, item) : 0;
  const earlier = journey === "forward" ? await prisma.shippingShipment.findFirst({ where: { itemId: item.id, journey: "forward", state: { not: "cancelled" } } }) : null;
  if (earlier && collectible > 0) throw conflict("A COD shipment already exists for this line. Resolve its collection/cancellation before sending a replacement.");
  let body: Record<string, unknown> = forwardBody(order, item, warehouse, input, id, collectible);
  if (journey === "return") {
    body = {
      order_id: id, order_date: new Date().toISOString().slice(0, 16).replace("T", " "),
      pickup_customer_name: address.name, pickup_address: address.line, pickup_city: address.city,
      pickup_state: address.state, pickup_country: "India", pickup_pincode: address.pincode,
      pickup_phone: address.phone, pickup_email: order.email,
      shipping_customer_name: warehouse.contactPerson, shipping_address: warehouse.address,
      shipping_city: warehouse.city, shipping_state: warehouse.state, shipping_country: "India",
      shipping_pincode: warehouse.pincode, shipping_phone: warehouse.phone, shipping_email: warehouse.email,
      warehouse_id: warehouse.velocityId, payment_method: "PREPAID", sub_total: item.unitPrice * item.quantity,
      order_items: [{
        name: item.title, sku: item.sku || item.id, units: item.quantity, selling_price: item.unitPrice,
        qc_enable: Boolean(input.returnQc),
        ...(input.returnQc ? { qc_product_name: input.returnQc.productName, qc_product_image: input.returnQc.image, qc_brand: input.returnQc.brand } : {}),
      }],
      length: input.length, breadth: input.width, height: input.height, weight: input.weightGrams / 1000, request_pickup: true,
    };
  }
  if (input.bookingMode === "orchestration") body.carrier_id = input.carrierId || "";
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const currentOrder = await tx.order.findUnique({ where: { id: orderId } });
    const currentItem = await tx.orderItem.findUnique({ where: { id: item.id } });
    if (!currentOrder || currentOrder.shippingBlocked || !currentOrder.settled || !["paid", "cod"].includes(currentOrder.paymentStatus)) {
      throw conflict("This order is being cancelled or is no longer eligible for shipping.");
    }
    if (!currentItem || ["cancelled", "refunded", "pending_payment"].includes(currentItem.status)) throw conflict("This line can no longer be shipped.");
    if (input.returnCaseId) {
      const currentReturn = await tx.returns.findUnique({ where: { id: input.returnCaseId } });
      if (currentReturn?.status !== "pickup_approved") throw conflict("Return pickup approval changed. Refresh the case.");
    } else {
      if (jobId) {
        const currentJob = await tx.printJob.findUnique({ where: { id: jobId } });
        if (currentJob?.status !== "ready") throw conflict("Print job readiness changed. Refresh before booking.");
      } else if (currentItem.status !== "accepted") throw conflict("Artist order acceptance changed. Refresh before booking.");
      if (currentItem.status === "return_requested") throw conflict("This line now has a return request.");
      if (collectible > 0 && await tx.shippingShipment.findFirst({ where: { itemId: item.id, journey: "forward", state: { not: "cancelled" } } })) {
        throw conflict("A COD shipment already exists for this line.");
      }
    }
    await tx.shippingShipment.create({ data: {
      id, bookingKey, orderId, itemId: item.id, jobId, returnCaseId: input.returnCaseId,
      creatorId: warehouse.owner.startsWith("creator:") ? item.creatorId : null,
      warehouseId: warehouse.id, journey, length: input.length, width: input.width, height: input.height,
      weightGrams: input.weightGrams, codAmount: collectible, request: json(body),
    } });
  });
  try {
    const endpoint = input.bookingMode === "orchestration"
      ? journey === "return" ? "reverse-order-orchestration" : "forward-order-orchestration"
      : journey === "return" ? "reverse-order" : "forward-order";
    const first = (await velocityRequest(endpoint, body, remoteBookingSchema)).payload;
    if (input.bookingMode === "orchestration" ? !first.awb_code : journey === "forward" ? !first.shipment_id : !first.return_id) {
      throw new HttpError(502, "Velocity did not return the booking reference. Reconcile this shipment.");
    }
    await prisma.shippingShipment.update({ where: { id }, data: {
      state: "order_created", remoteOrderId: first.order_id,
      remoteShipmentId: first.shipment_id, remoteReturnId: first.return_id,
    } });
    if (input.bookingMode === "order_only" && !first.awb_code) return shipmentView(await prisma.shippingShipment.findUniqueOrThrow({ where: { id } }));
    const assignment = first.awb_code ? first : (await velocityRequest(journey === "return" ? "reverse-order-shipment" : "forward-order-shipment",
      journey === "return"
        ? { return_id: first.return_id, warehouse_id: warehouse.velocityId, carrier_id: input.carrierId || "" }
        : { shipment_id: first.shipment_id, carrier_id: input.carrierId || "" },
      remoteBookingSchema)).payload;
    if (!assignment.awb_code) throw new HttpError(502, "Velocity did not generate an AWB. Reconcile this shipment.");
    return await finishBooking(id, { ...assignment, shipment_id: assignment.shipment_id || first.shipment_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Velocity booking failed.";
    await prisma.shippingShipment.update({ where: { id }, data: { state: "attention", error: message } });
    throw error;
  }
}

async function finishBooking(id: string, assignment: z.infer<typeof remoteBookingSchema>["payload"]) {
  let booked = await prisma.shippingShipment.update({ where: { id }, data: {
    state: "booked", status: "ready_for_pickup", remoteShipmentId: assignment.shipment_id,
    awb: assignment.awb_code, carrierId: assignment.courier_company_id, carrierName: assignment.courier_name,
    labelUrl: httpsUrl(assignment.label_url), charges: json(assignment.charges ?? {}), error: null,
  } });
  if (booked.journey === "forward") {
    await prisma.orderItem.update({ where: { id: booked.itemId }, data: { awb: booked.awb } });
    if (booked.jobId) await prisma.printJob.update({ where: { id: booked.jobId }, data: { awb: booked.awb } });
  }
  if (booked.labelUrl) {
    try {
      await cacheLabel(booked);
      booked = await prisma.shippingShipment.findUniqueOrThrow({ where: { id } });
    } catch (error) {
      const message = `Shipment booked, but label storage failed: ${error instanceof Error ? error.message : "Unknown storage error"}. Use Print label to retry; do not book again.`;
      console.error(`Label caching failed for ${id}: ${message}`);
      booked = await prisma.shippingShipment.update({ where: { id }, data: { error: message } });
    }
  }
  return shipmentView(booked);
}

export async function assignShipment(id: string, carrierId: string | undefined, actor: ShippingActor) {
  const shipment = await findShipment(id, actor);
  if (shipment.state !== "order_created" || shipment.awb) throw conflict("Only an unassigned order can be assigned. Reconcile uncertain bookings first.");
  if (shipment.journey === "forward" ? !shipment.remoteShipmentId : !shipment.remoteReturnId) throw conflict("The remote booking reference is missing. Reconcile first.");
  const parcel = { length: shipment.length, width: shipment.width, height: shipment.height, weightGrams: shipment.weightGrams };
  const request = z.object({
    warehouse_id: z.string().min(1), order_items: z.array(z.object({ qc_enable: z.boolean().optional() }).passthrough()),
    billing_pincode: z.string().optional(), pickup_pincode: z.string().optional(), shipping_pincode: z.string().optional(),
  }).passthrough().safeParse(shipment.request);
  if (!request.success) throw conflict("The stored booking details are incomplete. Reconcile in Velocity before assigning.");
  const { order, item } = await shippingLine(shipment.orderId, shipment.itemId, actor);
  const origin = shipment.journey === "return" ? request.data.pickup_pincode : undefined;
  const destination = shipment.journey === "return" ? request.data.shipping_pincode : request.data.billing_pincode;
  const warehouse = await prisma.shippingWarehouse.findUnique({ where: { id: shipment.warehouseId } });
  if (!warehouse || warehouse.velocityId !== request.data.warehouse_id) throw conflict("Pickup warehouse configuration changed since order creation. Resolve it in Velocity before assigning.");
  const from = origin ?? warehouse.pincode;
  if (!destination) throw conflict("The original parcel destination is missing. Reconcile before assigning.");
  const quote = (await velocityRequest("rates", rateBody(parcel,
    from, destination,
    shipment.journey === "return" ? "return" : "forward", shipment.codAmount,
    request.data.order_items.some((entry) => entry.qc_enable)), ratesSchema)).result;
  if (!quote.serviceable_couriers.length || (carrierId && !quote.serviceable_couriers.some((entry) => entry.carrier_id === carrierId))) throw conflict("Select an available courier for this parcel.");
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
    const currentOrder = await tx.order.findUnique({ where: { id: order.id } });
    const currentItem = await tx.orderItem.findUnique({ where: { id: item.id } });
    if (!currentOrder || currentOrder.shippingBlocked || !["paid", "cod"].includes(currentOrder.paymentStatus) || !currentItem || ["cancelled", "refunded"].includes(currentItem.status)) throw conflict("This order can no longer be assigned.");
    if (shipment.returnCaseId) {
      const returned = await tx.returns.findUnique({ where: { id: shipment.returnCaseId } });
      if (returned?.status !== "pickup_approved") throw conflict("Return pickup approval changed.");
    }
    const claimed = await tx.shippingShipment.updateMany({ where: { id, state: "order_created", awb: null }, data: { state: "assigning" } });
    if (!claimed.count) throw conflict("Courier assignment is already in progress. Reconcile before retrying.");
  });
  try {
    const result = (await velocityRequest(shipment.journey === "return" ? "reverse-order-shipment" : "forward-order-shipment",
      shipment.journey === "return" ? { return_id: shipment.remoteReturnId, warehouse_id: request.data.warehouse_id, carrier_id: carrierId || "" }
        : { shipment_id: shipment.remoteShipmentId, carrier_id: carrierId || "" }, remoteBookingSchema)).payload;
    if (!result.awb_code) throw new HttpError(502, "Velocity did not generate an AWB. Reconcile this shipment.");
    return await finishBooking(id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Courier assignment failed";
    await prisma.shippingShipment.update({ where: { id }, data: { state: "attention", error: message } });
    throw error;
  }
}

export function shipmentView(shipment: ShippingShipment) {
  const { request: _request, labelKey: _labelKey, ...result } = shipment;
  return { ...result, labelAvailable: Boolean(shipment.labelKey || shipment.labelUrl), labelUrl: httpsUrl(result.labelUrl), trackingUrl: httpsUrl(result.trackingUrl) };
}

async function cacheLabel(shipment: ShippingShipment) {
  if (shipment.labelKey) return shipment.labelKey;
  if (!shipment.labelUrl) throw conflict("Velocity did not provide a label. Obtain it from the Velocity dashboard.");
  const url = new URL(shipment.labelUrl);
  if (url.protocol !== "https:" || !/^velocity-shazam-(prod|staging)\.s3\.ap-south-1\.amazonaws\.com$/.test(url.hostname)) {
    throw conflict("This label host is not supported for automatic storage. Download it directly from Velocity.");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || !response.body) throw new HttpError(502, "Velocity label link expired or could not be downloaded. Obtain the label from Velocity.");
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 10 * 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(502, "Velocity label exceeds the 10 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const buffer = Buffer.concat(chunks);
  if (sniff(buffer)?.type !== "application/pdf") throw new HttpError(502, "Velocity returned a non-PDF label.");
  const key = `shipping-labels/${shipment.id}.pdf`;
  await putObject(key, buffer, "application/pdf");
  await prisma.shippingShipment.update({ where: { id: shipment.id }, data: { labelKey: key } });
  return key;
}

export async function shippingLabel(id: string, actor: ShippingActor) {
  const shipment = await findShipment(id, actor);
  return { url: await signedShippingLabel(await cacheLabel(shipment)) };
}

const trackingSchema = z.object({
  result: z.record(z.string(), z.object({
    tracking_data: z.object({
      shipment_status: z.string(),
      track_url: z.string().nullable().optional(),
      shipment_track_activities: z.array(z.object({ date: z.string(), activity: z.string(), location: z.string().nullable().optional() })).optional(),
    }),
  })),
});
const cancellableStatuses = ["pending", "ready_for_pickup", "pickup_scheduled", "return_pickup_scheduled", "not_picked", "return_not_picked"];

export async function cancelAwbs(awbs: string[]) {
  const unique = [...new Set(awbs)];
  const tracking = await velocityRequest("order-tracking", { awbs: unique }, trackingSchema);
  for (const awb of unique) {
    const status = tracking.result[awb]?.tracking_data.shipment_status;
    if (!status || !cancellableStatuses.includes(status)) throw conflict(`AWB ${awb} is missing or cannot be cancelled (${status || "unknown"}). No bulk cancellation was sent.`);
  }
  const result = await velocityRequest("cancel-order", { awbs: unique }, z.object({ message: z.string() }));
  await prisma.shippingShipment.updateMany({
    where: { awb: { in: unique }, state: { not: "cancelled" } }, data: { state: "cancel_requested" },
  });
  return result;
}
const listSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    attributes: z.object({
      tracking_number: z.string().nullable().optional(), status: z.string(),
      label_url: z.string().nullable().optional(),
      order: z.object({ id: z.string().optional(), external_id: z.string().nullable().optional(), display_id: z.string().nullable().optional() }).passthrough().optional(),
      shipment: z.object({ id: z.string(), tracking_number: z.string().nullable().optional(), status: z.string() }).passthrough().optional(),
    }).passthrough(),
  })),
});

export async function findShipment(id: string, actor: ShippingActor) {
  const shipment = await prisma.shippingShipment.findUnique({ where: { id } });
  if (!shipment || (actor.creatorId && shipment.creatorId !== actor.creatorId)) throw notFound("Shipment not found");
  return shipment;
}

async function syncItem(shipment: ShippingShipment) {
  if (shipment.journey !== "forward") return;
  const item = await prisma.orderItem.findUnique({ where: { id: shipment.itemId } });
  if (!item || ["cancelled", "refunded", "return_requested"].includes(item.status)) return;
  const delivered = shipment.status === "delivered";
  const moved = delivered || ["in_transit", "out_for_delivery", "ndr_raised", "need_attention", "reattempt_delivery", "rto_initiated", "rto_in_transit", "rto_delivered"].includes(shipment.status);
  if (moved) {
    await prisma.orderItem.updateMany({ where: { id: item.id, status: { notIn: ["delivered", "cancelled", "refunded", "return_requested"] } }, data: { status: "shipped", awb: shipment.awb } });
    if (shipment.jobId) await prisma.printJob.updateMany({ where: { id: shipment.jobId, status: { notIn: ["cancelled", "reprint"] } }, data: {
      status: "dispatched", awb: shipment.awb,
      ndr: shipment.status.startsWith("rto_") ? "rto" : ["ndr_raised", "need_attention"].includes(shipment.status) ? "ndr" : "clear",
    } });
  }
  if (delivered && item.status !== "delivered") await markDelivered(shipment.orderId, item.id);
}

export async function refreshShipment(id: string, actor: ShippingActor) {
  let shipment = await findShipment(id, actor);
  if (!shipment.awb) {
    if (["creating", "order_created"].includes(shipment.state) && Date.now() - shipment.updatedAt.getTime() < 120_000) {
      throw conflict("Booking is still in progress. Wait before reconciling.");
    }
    const result = await velocityRequest(shipment.journey === "return" ? "returns" : "shipments", {
      page: 1, per_page: 100, search: shipment.id,
    }, listSchema);
    const matches = result.data.filter((row) =>
      row.attributes.order?.external_id === shipment.id || row.attributes.order?.display_id === shipment.id ||
      row.attributes.order?.id === shipment.remoteOrderId ||
      (shipment.journey === "return" ? row.id === shipment.remoteReturnId : row.id === shipment.remoteShipmentId));
    if (matches.length !== 1) throw conflict("Cannot uniquely reconcile the booking. Check this reference in Velocity; do not create another parcel.");
    const row = matches[0];
    const awb = row.attributes.shipment?.tracking_number || row.attributes.tracking_number;
    if (!awb) throw conflict("The order exists in Velocity but has no AWB. Complete courier assignment in Velocity, then refresh here.");
    shipment = await prisma.shippingShipment.update({ where: { id }, data: {
      awb, remoteShipmentId: row.attributes.shipment?.id || row.id, state: "booked",
      status: row.attributes.shipment?.status || row.attributes.status,
      labelUrl: httpsUrl(row.attributes.label_url), error: null,
    } });
  }
  const result = await velocityRequest("order-tracking", { awbs: [shipment.awb] }, trackingSchema);
  const track = result.result[shipment.awb!]?.tracking_data;
  if (!track) throw new HttpError(502, "Velocity did not return tracking for this AWB.");
  const status = shipment.journey === "return" && ["delivered", "in_transit", "pickup_scheduled", "not_picked", "cancelled", "ndr_raised", "need_attention"].includes(track.shipment_status)
    ? `return_${track.shipment_status}` : track.shipment_status;
  const cancelled = ["cancelled", "return_cancelled", "rejected", "return_rejected"].includes(status);
  const updated = await prisma.shippingShipment.update({ where: { id }, data: {
    status, state: cancelled ? "cancelled" : shipment.state,
    ...(cancelled && shipment.state !== "cancelled" ? { bookingKey: `${shipment.bookingKey}:cancelled:${shipment.id}` } : {}),
    trackingUrl: httpsUrl(track.track_url), tracking: json(track.shipment_track_activities ?? []), syncedAt: new Date(), error: null,
  } });
  await syncItem(updated);
  return shipmentView(updated);
}

export async function cancelShipment(id: string, actor: ShippingActor) {
  const shipment = await findShipment(id, actor);
  if (shipment.state === "cancelled") return shipmentView(shipment);
  if (shipment.state === "cancel_requested") return shipmentView(shipment);
  if (!shipment.awb) throw conflict("Reconcile the booking to obtain its AWB before cancelling.");
  const refreshed = await refreshShipment(id, actor);
  if (!cancellableStatuses.includes(refreshed.status)) {
    throw conflict("This shipment is already picked up or cannot be cancelled. Use a return pickup where applicable.");
  }
  await velocityRequest("cancel-order", { awbs: [shipment.awb] }, z.object({ message: z.string() }));
  return shipmentView(await prisma.shippingShipment.update({ where: { id }, data: { state: "cancel_requested" } }));
}

export async function reconcileShipping() {
  const shipments = await prisma.shippingShipment.findMany({
    where: { awb: { not: null }, state: { in: ["booked", "cancel_requested", "attention"] }, status: { notIn: ["delivered", "return_delivered", "rto_delivered", "lost"] } },
    orderBy: { syncedAt: { sort: "asc", nulls: "first" } }, take: 25,
  });
  for (const shipment of shipments) {
    try { await refreshShipment(shipment.id, {}); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Tracking reconciliation failed";
      console.error(`Shipping reconciliation failed for ${shipment.id}: ${message}`);
      await prisma.shippingShipment.update({ where: { id: shipment.id }, data: { error: message, syncedAt: new Date() } });
    }
  }
}

export async function ensureDispatchAwb(itemId: string, jobId: string | undefined, requested?: string) {
  const shipment = await prisma.shippingShipment.findFirst({
    where: { itemId, journey: "forward", ...(jobId ? { jobId } : {}), state: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
  });
  if (!shipment) return requested;
  if (shipment.state !== "booked" || !shipment.awb) throw conflict("Velocity booking must complete before dispatch.");
  if (requested && requested !== shipment.awb) throw conflict("Use the AWB assigned by Velocity for this parcel.");
  return shipment.awb;
}

export async function customerTracking(orderId: string) {
  const shipments = await prisma.shippingShipment.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  return shipments.map((shipment) => ({
    id: shipment.id, itemId: shipment.itemId, journey: shipment.journey, status: shipment.status,
    awb: shipment.awb, carrierName: shipment.carrierName, trackingUrl: httpsUrl(shipment.trackingUrl),
    tracking: shipment.tracking, syncedAt: shipment.syncedAt,
  }));
}
