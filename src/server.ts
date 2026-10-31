import { buildApp } from "./app";
import { env } from "./lib/env";
import { prisma } from "./lib/db";
import { activateDueGiftCards } from "./services/giftcards";
import { reconcilePendingPayments } from "./services/payments";
import { reconcileShipping } from "./services/shipping";
import { velocityConfigured } from "./services/velocity";

const app = buildApp();
const server = app.listen(env.port, () => console.log(`Introvart API listening on :${env.port}`));

// Scheduled gift cards go live on their send date.
const timer = setInterval(() => {
  activateDueGiftCards().catch((error) => console.error("Gift card activation failed", error));
}, 60 * 60 * 1000);
timer.unref();

// Picks up payments whose webhook never arrived and releases stock held by abandoned checkouts.
const paymentTimer = setInterval(() => {
  reconcilePendingPayments().catch((error) => console.error("Payment reconciliation failed", error));
}, 5 * 60 * 1000);
paymentTimer.unref();

let shippingRunning = false;
const shippingTimer = setInterval(() => {
  if (!velocityConfigured() || shippingRunning) return;
  shippingRunning = true;
  reconcileShipping()
    .catch((error) => console.error("Shipping reconciliation failed", error))
    .finally(() => { shippingRunning = false; });
}, 5 * 60_000);
shippingTimer.unref();

async function shutdown() {
  clearInterval(timer);
  clearInterval(paymentTimer);
  clearInterval(shippingTimer);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
