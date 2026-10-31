import crypto from "node:crypto";
import { env } from "../lib/env";
import { HttpError } from "../lib/http";

const BASE_URL = { sandbox: "https://sandbox.cashfree.com/pg", production: "https://api.cashfree.com/pg" } as const;
const TIMEOUT_MS = 15_000;

export const cashfreeConfigured = () => Boolean(env.cashfree.appId && env.cashfree.secretKey);

export class CashfreeError extends HttpError {
  constructor(public cashfreeStatus: number, public code: string, message: string) {
    super(502, `Payment provider: ${message}`);
  }
}

type Json = Record<string, unknown>;

async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: Json, headers: Record<string, string> = {}): Promise<T> {
  if (!cashfreeConfigured()) throw new HttpError(503, "Online payments are not available right now");
  let response: Response;
  try {
    response = await fetch(`${BASE_URL[env.cashfree.environment]}${path}`, {
      method,
      headers: {
        "x-client-id": env.cashfree.appId,
        "x-client-secret": env.cashfree.secretKey,
        "x-api-version": env.cashfree.apiVersion,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(504, "The payment provider did not respond. Please try again.");
  }
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!response.ok) {
    const error = (data ?? {}) as { message?: string; code?: string };
    throw new CashfreeError(response.status, error.code ?? "", error.message ?? `request failed (${response.status})`);
  }
  return data as T;
}

export type CashfreeOrder = {
  cf_order_id: string | number;
  order_id: string;
  order_amount: number;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED" | string;
  payment_session_id: string;
};

export type CashfreePayment = {
  cf_payment_id: string | number;
  payment_status: "SUCCESS" | "FAILED" | "PENDING" | "NOT_ATTEMPTED" | "USER_DROPPED" | "CANCELLED" | "VOID" | string;
  payment_amount: number;
  payment_group?: string;
};

export type CashfreeRefund = { cf_refund_id: string | number; refund_id: string; refund_status: string; refund_amount: number };

// Cashfree ids may only contain letters, digits, underscores and hyphens.
const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50);

export const getCashfreeOrder = (orderId: string) => call<CashfreeOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
export const getCashfreePayments = (orderId: string) => call<CashfreePayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
// Stops a shopper paying for an order that has since been cancelled.
export const terminateCashfreeOrder = (orderId: string) => call<CashfreeOrder>("PATCH", `/orders/${encodeURIComponent(orderId)}`, { order_status: "TERMINATED" });

export async function createCashfreeOrder(input: {
  orderId: string;
  amount: number;
  customer: { id: string; name: string; email: string; phone: string };
  returnUrl?: string;
  notifyUrl?: string;
  expiresAt: Date;
}) {
  const body: Json = {
    order_id: input.orderId,
    order_amount: Number(input.amount.toFixed(2)),
    order_currency: "INR",
    customer_details: {
      customer_id: safeId(input.customer.id),
      customer_name: input.customer.name.slice(0, 100),
      customer_email: input.customer.email,
      customer_phone: input.customer.phone,
    },
    order_meta: {
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
    },
    order_expiry_time: input.expiresAt.toISOString(),
    order_note: `Introvart order ${input.orderId}`,
  };
  try {
    return await call<CashfreeOrder>("POST", "/orders", body);
  } catch (error) {
    // The shopper closed the popup earlier and is paying again: reuse the same Cashfree order.
    if (error instanceof CashfreeError && (error.cashfreeStatus === 409 || /already/i.test(error.code))) {
      return getCashfreeOrder(input.orderId);
    }
    throw error;
  }
}

export function createCashfreeRefund(input: { orderId: string; refundId: string; amount: number; note: string }) {
  return call<CashfreeRefund>(
    "POST",
    `/orders/${encodeURIComponent(input.orderId)}/refunds`,
    { refund_id: input.refundId, refund_amount: Number(input.amount.toFixed(2)), refund_note: input.note.slice(0, 100), refund_speed: "STANDARD" },
    { "x-idempotency-key": input.refundId },
  );
}

// Cashfree signs `timestamp + rawBody` with the merchant secret (HMAC-SHA256, base64).
export function verifyWebhookSignature(rawBody: Buffer | string, timestamp: string, signature: string) {
  if (!env.cashfree.secretKey || !timestamp || !signature) return false;
  const expected = crypto.createHmac("sha256", env.cashfree.secretKey).update(`${timestamp}${rawBody.toString("utf8")}`).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function paymentMethodLabel(group: string | undefined) {
  const key = (group ?? "").toLowerCase();
  if (key === "upi") return "UPI";
  if (key === "credit_card" || key === "debit_card") return "CARD";
  if (key === "net_banking") return "NETBANKING";
  if (key === "wallet") return "WALLET";
  return key ? key.toUpperCase() : "ONLINE";
}

// Sends money back through Cashfree for orders that were paid online. Returns null for COD, credit-only
// and legacy orders, which have no gateway payment to reverse.
export async function refundOnGateway(
  order: { id: string; gatewayPaymentId: string | null; payable: number; refunded: number },
  amount: number,
  note: string,
  refundId?: string,
) {
  if (!order.gatewayPaymentId) return null;
  const refundable = Math.min(amount, order.payable - order.refunded);
  if (refundable <= 0) return null;
  const reference = refundId ?? `RF-${order.id}-${crypto.randomBytes(3).toString("hex")}`.slice(0, 40);
  return createCashfreeRefund({ orderId: order.id, refundId: reference, amount: refundable, note });
}
