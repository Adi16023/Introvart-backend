import { Router } from "express";
import { env } from "../lib/env";
import { badRequest } from "../lib/http";
import { cashfreeConfigured, verifyWebhookSignature } from "../services/cashfree";
import { confirmPayment } from "../services/payments";

export const paymentsWebhookRouter = Router();

type CashfreeWebhook = { type?: string; data?: { order?: { order_id?: string } } };

// Cashfree calls this when a payment succeeds, fails or is dropped. The signature proves it came from Cashfree,
// and the order's real state is then re-read from Cashfree rather than taken from the payload.
paymentsWebhookRouter.post("/payments/cashfree/webhook", async (req, res) => {
  if (!cashfreeConfigured()) return void res.status(503).json({ error: "Online payments are not configured" });
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  const timestamp = String(req.header("x-webhook-timestamp") ?? "");
  const signature = String(req.header("x-webhook-signature") ?? "");
  if (!raw || !verifyWebhookSignature(raw, timestamp, signature)) throw badRequest("Invalid webhook signature");

  const event = req.body as CashfreeWebhook;
  const orderId = event.data?.order?.order_id;
  if (orderId && /PAYMENT_(SUCCESS|FAILED|USER_DROPPED)/.test(event.type ?? "")) {
    try {
      await confirmPayment(orderId);
    } catch (error) {
      // Unknown orders (for example from other apps on the same account) are acknowledged so Cashfree stops retrying.
      if ((error as { status?: number }).status === 404) return void res.json({ ok: true });
      throw error;
    }
  }
  res.json({ ok: true, environment: env.cashfree.environment });
});
