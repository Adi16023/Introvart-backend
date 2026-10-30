import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { conflict, HttpError, notFound } from "../lib/http";
import { CashfreeError, cashfreeConfigured, createCashfreeOrder, getCashfreeOrder, getCashfreePayments, paymentMethodLabel } from "./cashfree";
import { getOrder, recordPayment } from "./orders";

const SESSION_MINUTES = 60;
// A pending order whose payment was never started is abandoned after this long, releasing its reserved stock.
const ABANDON_AFTER_MS = (SESSION_MINUTES + 15) * 60_000;
const ENDED = ["EXPIRED", "TERMINATED", "TERMINATION_REQUESTED"];

// One process serves the API, so confirmations for the same order (webhook + shopper + sweeper) run one at a time.
const running = new Map<string, Promise<unknown>>();
function exclusive<T>(orderId: string, work: () => Promise<T>): Promise<T> {
  const previous = running.get(orderId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  running.set(orderId, next);
  void next.finally(() => { if (running.get(orderId) === next) running.delete(orderId); }).catch(() => undefined);
  return next;
}

export async function startPayment(orderId: string) {
  if (!cashfreeConfigured()) throw new HttpError(503, "Online payments are not available right now");
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound("Order not found");
  if (order.paymentStatus !== "pending") throw conflict(order.paymentStatus === "paid" ? "This order is already paid" : "This order can no longer be paid. Please place it again.");
  if (order.payable <= 0) throw conflict("Nothing is left to pay on this order");

  const address = order.address as { phone?: string } | null;
  const phone = (address?.phone ?? "").replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) throw new HttpError(400, "Enter a valid 10-digit phone number to pay online");

  const apiUrl = env.publicUrl;
  const session = await createCashfreeOrder({
    orderId: order.id,
    amount: order.payable,
    customer: { id: order.ownerId ?? order.customerId, name: order.customerName, email: order.email, phone },
    returnUrl: env.frontendUrl ? `${env.frontendUrl}/account/orders/${order.id}` : undefined,
    // Cashfree only delivers webhooks to public https addresses.
    notifyUrl: apiUrl.startsWith("https://") ? `${apiUrl}/api/v1/payments/cashfree/webhook` : undefined,
    expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000),
  });
  if (session.order_status !== "ACTIVE") {
    // The attempt already finished (paid or expired): sync our order instead of opening a dead session.
    await confirmPayment(order.id);
    throw conflict(session.order_status === "PAID" ? "This order is already paid" : "This payment session has ended. Please place the order again.");
  }
  return { paymentSessionId: session.payment_session_id, environment: env.cashfree.environment, orderId: order.id };
}

// Never trusts the browser or the webhook body: the outcome is always read back from Cashfree.
export function confirmPayment(orderId: string) {
  return exclusive(orderId, async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound("Order not found");
    if (order.paymentStatus !== "pending" || !cashfreeConfigured()) return getOrder(orderId);

    let remote;
    try {
      remote = await getCashfreeOrder(orderId);
    } catch (error) {
      if (error instanceof CashfreeError && error.cashfreeStatus === 404) {
        if (Date.now() - order.createdAt.getTime() > ABANDON_AFTER_MS) await recordPayment(orderId, "failed");
        return getOrder(orderId);
      }
      throw error;
    }

    if (remote.order_status === "PAID") {
      if (Math.abs(remote.order_amount - order.payable) > 0.01) {
        throw conflict(`Cashfree reports ₹${remote.order_amount} paid for ${orderId} but ₹${order.payable} was expected. Review it in the Cashfree dashboard.`);
      }
      const payments = await getCashfreePayments(orderId);
      const success = payments.find((payment) => payment.payment_status === "SUCCESS");
      await prisma.order.update({
        where: { id: orderId },
        data: { gatewayPaymentId: success ? String(success.cf_payment_id) : null, paymentMethod: paymentMethodLabel(success?.payment_group) },
      });
      return recordPayment(orderId, "paid");
    }
    if (ENDED.includes(remote.order_status)) return recordPayment(orderId, "failed");
    return getOrder(orderId);
  });
}

// Catches payments whose webhook never arrived and frees stock held by checkouts that were abandoned.
export async function reconcilePendingPayments() {
  if (!cashfreeConfigured()) return;
  const pending = await prisma.order.findMany({
    where: { paymentStatus: "pending", paymentMethod: "ONLINE", createdAt: { lt: new Date(Date.now() - 2 * 60_000), gt: new Date(Date.now() - 3 * 86_400_000) } },
    select: { id: true },
    take: 50,
  });
  for (const { id } of pending) {
    try { await confirmPayment(id); } catch (error) { console.error(`Could not reconcile payment for ${id}`, error); }
  }
}
