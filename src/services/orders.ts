import type { Order, OrderItem } from "@prisma/client";
import { json, prisma, transaction, type Tx } from "../lib/db";
import { badRequest, conflict, displayDate, notFound, uid } from "../lib/http";
import { computeTotals } from "./cart";
import { frameOf, loadConfig, materialOf, pincodeInfo, PRESS_TYPES, sizeOf } from "./pricing";
import { variantLabel } from "./product-variants";

export type AddressInput = {
  id?: string;
  name: string;
  phone: string;
  line: string;
  city: string;
  state: string;
  pincode: string;
  label?: string;
};

export type PlaceOrderInput = {
  ownerId: string;
  customerId?: string;
  address: AddressInput;
  delivery: "standard" | "express";
  paymentMethod: string;
  coupon?: string;
  giftCardCode?: string;
  useCredit?: boolean;
  email: string;
  name: string;
  gstInvoice?: boolean;
};

const addDays = (days: number) => displayDate(new Date(Date.now() + days * 86400000));

export function jobSpec(item: Pick<OrderItem, "sizeLabel" | "materialLabel" | "frameLabel" | "personalization">) {
  const extras = item.personalization && typeof item.personalization === "object"
    ? Object.entries(item.personalization as Record<string, string>).map(([key, value]) => `${key}: ${value}`)
    : [];
  return [`${item.sizeLabel} · ${item.materialLabel} · ${item.frameLabel}`, ...extras].join(" · ");
}

export async function placeOrder(input: PlaceOrderInput) {
  const config = await loadConfig();
  const pin = pincodeInfo(input.address.pincode);
  if (!pin.ok) throw badRequest(pin.eta);

  const calc = await computeTotals(prisma, config, {
    ownerId: input.ownerId,
    customerId: input.customerId,
    coupon: input.coupon,
    giftCardCode: input.giftCardCode,
    useCredit: input.useCredit,
    delivery: input.delivery,
    pincode: input.address.pincode,
  });
  const { totals, lines, couponRow, giftCard } = calc;

  if (!lines.length) throw badRequest("Your cart is empty");
  const broken = lines.find((line) => line.problem);
  if (broken?.problem) throw conflict(broken.problem);
  if (input.coupon && !totals.couponOk) throw badRequest(totals.message);
  if (input.giftCardCode && !giftCard) throw badRequest("That gift card is not active");
  const method = input.paymentMethod.toLowerCase();
  if (method === "cod" && !totals.codAllowed) {
    throw badRequest(`Cash on delivery is only available under ₹${config.codLimit.toLocaleString("en-IN")} on metro and standard lanes`);
  }

  const orderId = uid("ORD");
  const coversEverything = totals.payable === 0;
  const settleNow = method === "cod" || coversEverything;
  const customer = calc.customer;

  await transaction(async (tx) => {
    for (const line of lines) {
      if (line.variant?.inventoryTracker) {
        const reserved = await tx.productVariant.updateMany({
          where: {
            id: line.variant.id,
            ...(line.variant.inventoryPolicy === "continue" ? {} : { inventoryQuantity: { gte: line.quantity } }),
          },
          data: { inventoryQuantity: { decrement: line.quantity } },
        });
        if (!reserved.count) throw conflict(`${line.title} just sold out`);
      }
      if (line.artwork && line.artwork.stock !== null) {
        const reserved = await tx.artwork.updateMany({
          where: { id: line.artwork.id, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } },
        });
        if (reserved.count === 0) throw conflict(`${line.title} just sold out`);
      }
    }

    await tx.order.create({
      data: {
        id: orderId,
        ownerId: input.ownerId,
        customerId: customer?.id ?? "guest",
        customerName: input.name,
        email: input.email,
        placedAt: displayDate(),
        address: json({ ...input.address, id: input.address.id ?? uid("AD"), label: input.address.label ?? "Home" }),
        delivery: input.delivery,
        paymentMethod: coversEverything && method !== "cod" ? "CREDIT" : method.toUpperCase(),
        paymentStatus: settleNow ? (method === "cod" && !coversEverything ? "cod" : "paid") : "pending",
        coupon: couponRow && totals.couponOk ? couponRow.code : undefined,
        discount: totals.discount,
        shipping: totals.shipping,
        giftCardCode: giftCard ? giftCard.code : undefined,
        giftCardAmount: totals.giftCardAmount,
        creditUsed: totals.creditUsed,
        subtotal: totals.subtotal,
        gst: totals.gst,
        payable: totals.payable,
        gstInvoice: input.gstInvoice ?? true,
        stockReserved: true,
        items: {
          create: lines.map((line) => ({
            id: uid("OI"),
            artworkId: line.artworkId,
            variantId: line.variantId,
            sku: line.variant?.sku ?? "",
            title: line.title,
            artistName: line.artistName,
            image: line.image,
            fulfilment: line.fulfilment,
            sizeLabel: line.variant ? variantLabel(line.variant) : sizeOf(config, line.sizeId).label,
            materialLabel: line.variant ? "As listed" : materialOf(config, line.materialId).label,
            frameLabel: line.variant ? "As listed" : frameOf(config, line.frameId).label,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            status: "pending_payment",
            gift: line.gift,
            giftMessage: line.giftMessage,
            creatorId: line.artwork?.artistId,
            personalization: line.personalization ?? undefined,
          })),
        },
      },
    });

    if (settleNow) await settleOrder(tx, orderId);
  });

  return getOrder(orderId);
}

// Redeems gift card / credit / coupon, confirms lines, queues press jobs and empties the cart.
// Called once an order is paid (or COD is accepted). Idempotent via Order.settled.
export async function settleOrder(tx: Tx, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) throw notFound("Order not found");
  if (order.settled) return;

  if (order.giftCardCode && order.giftCardAmount) {
    const card = await tx.giftCard.findFirst({ where: { code: { equals: order.giftCardCode, mode: "insensitive" } } });
    if (card) await tx.giftCard.update({ where: { id: card.id }, data: { balance: Math.max(0, card.balance - order.giftCardAmount) } });
  }
  if (order.creditUsed && order.customerId !== "guest") {
    const customer = await tx.customer.findUnique({ where: { id: order.customerId } });
    if (customer) await tx.customer.update({ where: { id: customer.id }, data: { credit: Math.max(0, customer.credit - order.creditUsed) } });
  }
  if (order.coupon) await tx.coupon.updateMany({ where: { code: order.coupon }, data: { used: { increment: 1 } } });

  await tx.orderItem.updateMany({ where: { orderId, status: "pending_payment" }, data: { status: "confirmed" } });

  const pressItems = order.items.filter((item) => PRESS_TYPES.includes(item.fulfilment));
  if (pressItems.length) {
    await tx.printJob.createMany({
      data: pressItems.map((item) => ({
        id: uid("JOB"),
        orderId,
        itemId: item.id,
        title: item.title,
        image: item.image,
        spec: jobSpec(item),
        quantity: item.quantity,
        status: "new",
        priority: order.delivery === "express" ? "rush" : "normal",
        due: addDays(order.delivery === "express" ? 2 : 4),
        giftSlip: item.gift,
      })),
    });
  }

  if (order.ownerId) await tx.cartItem.deleteMany({ where: { ownerId: order.ownerId } });
  await tx.order.update({ where: { id: orderId }, data: { settled: true } });
}

async function releaseStock(tx: Tx, order: Order & { items: OrderItem[] }) {
  if (!order.stockReserved) return;
  for (const item of order.items) {
    if (item.variantId) await tx.productVariant.updateMany({
      where: { id: item.variantId, inventoryTracker: { not: "" } },
      data: { inventoryQuantity: { increment: item.quantity } },
    });
    if (!item.artworkId) continue;
    await tx.artwork.updateMany({ where: { id: item.artworkId, stock: { not: null } }, data: { stock: { increment: item.quantity } } });
  }
  await tx.order.update({ where: { id: order.id }, data: { stockReserved: false } });
}

async function reserveStock(tx: Tx, order: Order & { items: OrderItem[] }) {
  if (order.stockReserved) return;
  for (const item of order.items) {
    if (item.variantId) {
      const variant = await tx.productVariant.findUnique({ where: { id: item.variantId } });
      if (!variant) throw conflict(`The variant of ${item.title} is no longer available`);
      if (variant.inventoryTracker) {
        const taken = await tx.productVariant.updateMany({
          where: { id: variant.id, ...(variant.inventoryPolicy === "continue" ? {} : { inventoryQuantity: { gte: item.quantity } }) },
          data: { inventoryQuantity: { decrement: item.quantity } },
        });
        if (!taken.count) throw conflict(`${item.title} sold out while payment was pending`);
      }
    }
    if (!item.artworkId) continue;
    const artwork = await tx.artwork.findUnique({ where: { id: item.artworkId }, select: { stock: true, title: true } });
    if (artwork && artwork.stock !== null) {
      const taken = await tx.artwork.updateMany({
        where: { id: item.artworkId, stock: { gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      });
      if (taken.count === 0) throw conflict(`${artwork.title} sold out while payment was pending`);
    }
  }
  await tx.order.update({ where: { id: order.id }, data: { stockReserved: true } });
}

// The single hook a payment gateway webhook will call once one is wired in.
export async function recordPayment(orderId: string, result: "paid" | "failed") {
  await transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw notFound("Order not found");
    if (order.paymentStatus === "cod") throw conflict("Cash on delivery orders have no online payment");
    if (order.paymentStatus === "cancelled" || order.paymentStatus === "refunded") throw conflict("This order was cancelled");

    if (result === "paid") {
      if (order.paymentStatus === "paid") return;
      await reserveStock(tx, order);
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "paid" } });
      await settleOrder(tx, orderId);
      return;
    }
    if (order.paymentStatus === "paid") throw conflict("A paid order cannot be marked failed");
    await releaseStock(tx, order);
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "failed" } });
    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "pending_payment" } });
  });
  return getOrder(orderId);
}

const CANCELLABLE = ["pending_payment", "confirmed"];

export async function cancelOrder(orderId: string) {
  await transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw notFound("Order not found");
    if (order.paymentStatus === "cancelled" || order.paymentStatus === "refunded") return;
    if (order.items.some((item) => !CANCELLABLE.includes(item.status))) {
      throw conflict("Production or dispatch has started. Open a return instead.");
    }
    await releaseStock(tx, order);
    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "cancelled" } });
    await tx.printJob.updateMany({ where: { orderId, status: { in: ["new", "accepted"] } }, data: { status: "cancelled" } });

    let refunded = 0;
    let paymentStatus = "cancelled";
    if (order.settled) {
      if (order.giftCardCode && order.giftCardAmount) {
        const card = await tx.giftCard.findFirst({ where: { code: { equals: order.giftCardCode, mode: "insensitive" } } });
        if (card && card.status !== "void") await tx.giftCard.update({ where: { id: card.id }, data: { balance: { increment: order.giftCardAmount } } });
      }
      if (order.creditUsed && order.customerId !== "guest") {
        await tx.customer.updateMany({ where: { id: order.customerId }, data: { credit: { increment: order.creditUsed } } });
      }
      if (order.coupon) await tx.coupon.updateMany({ where: { code: order.coupon, used: { gt: 0 } }, data: { used: { decrement: 1 } } });
      if (order.paymentStatus === "paid") {
        refunded = order.payable;
        paymentStatus = "refunded";
      }
    }
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus, refunded } });
  });
  return getOrder(orderId);
}

export async function markDelivered(orderId: string, itemId: string) {
  await transaction(async (tx) => {
    const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId } });
    if (!item) throw notFound("Order line not found");
    if (item.status === "delivered") return;
    if (!["shipped", "return_requested"].includes(item.status)) throw conflict("Only a shipped line can be marked delivered");
    await tx.orderItem.update({ where: { id: itemId }, data: { status: "delivered", deliveredAt: new Date() } });
    const open = await tx.orderItem.count({ where: { orderId, status: { notIn: ["delivered", "cancelled", "refunded"] } } });
    if (open === 0) {
      // Cash is collected on delivery.
      await tx.order.updateMany({ where: { id: orderId, paymentStatus: "cod" }, data: { paymentStatus: "paid" } });
    }
  });
  return getOrder(orderId);
}

export async function getOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, jobs: { orderBy: { createdAt: "desc" } }, returns: { orderBy: { createdAt: "desc" } } },
  });
  if (!order) throw notFound("Order not found");
  return order;
}

export function invoiceOf(order: Awaited<ReturnType<typeof getOrder>>) {
  const lines = order.items
    .filter((item) => item.status !== "cancelled")
    .map((item) => ({ title: item.title, quantity: item.quantity, unitPrice: item.unitPrice, amount: item.unitPrice * item.quantity }));
  return {
    invoiceNo: `INV-${order.id}`,
    orderId: order.id,
    issuedOn: order.placedAt,
    billTo: { name: order.customerName, email: order.email, address: order.address },
    lines,
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: order.shipping,
    giftCardAmount: order.giftCardAmount,
    creditUsed: order.creditUsed,
    gstIncluded: order.gst,
    total: order.payable,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    hidePrices: order.items.every((item) => item.gift),
  };
}
