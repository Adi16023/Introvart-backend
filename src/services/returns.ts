import { transaction } from "../lib/db";
import { badRequest, conflict, notFound, uid } from "../lib/http";
import { PRESS_TYPES } from "./pricing";
import { jobSpec } from "./orders";

export async function openReturn(input: {
  customerId: string;
  orderId: string;
  itemId?: string;
  itemTitle?: string;
  reason: string;
  type: "refund" | "replacement" | "reprint";
  evidence?: string;
  photos?: string[];
}) {
  return transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId }, include: { items: true } });
    if (!order || order.customerId !== input.customerId) throw notFound("Order not found");
    const item = order.items.find((entry) => (input.itemId ? entry.id === input.itemId : entry.title === input.itemTitle));
    if (!item) throw notFound("That line is not on this order");
    if (["pending_payment", "cancelled", "refunded"].includes(item.status)) throw conflict("This line cannot be returned");
    const existing = await tx.returns.findFirst({
      where: { orderId: order.id, itemId: item.id, status: { notIn: ["rejected", "closed", "refunded"] } },
    });
    if (existing) throw conflict(`Return ${existing.id} is already open for this line`);

    const created = await tx.returns.create({
      data: {
        id: uid("RET"),
        orderId: order.id,
        itemId: item.id,
        itemTitle: item.title,
        reason: input.reason,
        type: input.type,
        status: "opened",
        evidence: input.evidence || (input.photos?.length ? `${input.photos.length} photo(s) attached to the case.` : "Photo noted on the case."),
        photos: input.photos ?? [],
      },
    });
    await tx.orderItem.update({ where: { id: item.id }, data: { status: "return_requested" } });
    return created;
  });
}

export const RETURN_DECISIONS = ["refunded", "replacement", "reprint", "rejected", "evidence_review", "closed"] as const;

export async function decideReturn(returnId: string, decision: (typeof RETURN_DECISIONS)[number]) {
  return transaction(async (tx) => {
    const found = await tx.returns.findUnique({ where: { id: returnId }, include: { order: { include: { items: true } } } });
    if (!found) throw notFound("Return not found");
    if (["refunded", "rejected", "closed"].includes(found.status)) throw conflict(`Return is already ${found.status}`);
    const item = found.order.items.find((entry) => entry.id === found.itemId || (!found.itemId && entry.title === found.itemTitle));

    if (decision === "evidence_review") {
      return tx.returns.update({ where: { id: returnId }, data: { status: decision } });
    }

    if (decision === "refunded") {
      if (!item) throw badRequest("Order line missing for this return");
      const amount = item.unitPrice * item.quantity;
      // Cash on delivery refunds become store credit; prepaid money goes back to the payment method.
      if (found.order.paymentMethod === "COD" && found.order.customerId !== "guest") {
        await tx.customer.updateMany({ where: { id: found.order.customerId }, data: { credit: { increment: amount } } });
      } else {
        await tx.order.update({ where: { id: found.orderId }, data: { refunded: { increment: amount } } });
      }
      await tx.orderItem.update({ where: { id: item.id }, data: { status: "refunded" } });
    } else if (decision === "replacement" || decision === "reprint") {
      if (item) {
        const press = PRESS_TYPES.includes(item.fulfilment);
        if (press) {
          await tx.printJob.create({
            data: {
              id: uid("JOB"),
              orderId: item.orderId,
              itemId: item.id,
              title: item.title,
              image: item.image,
              spec: jobSpec(item),
              quantity: item.quantity,
              status: "new",
              priority: "rush",
              due: "In 3 days",
              giftSlip: item.gift,
            },
          });
        }
        await tx.orderItem.update({ where: { id: item.id }, data: { status: press ? "in_production" : "accepted" } });
      }
    } else if (item) {
      // rejected or closed without remedy: the line goes back to delivered
      await tx.orderItem.update({ where: { id: item.id }, data: { status: "delivered" } });
    }
    return tx.returns.update({ where: { id: returnId }, data: { status: decision } });
  });
}
