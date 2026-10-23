import { buildApp } from "./app";
import { env } from "./lib/env";
import { prisma } from "./lib/db";
import { activateDueGiftCards } from "./services/giftcards";

const app = buildApp();
const server = app.listen(env.port, () => console.log(`Introvart API listening on :${env.port}`));

// Scheduled gift cards go live on their send date.
const timer = setInterval(() => {
  activateDueGiftCards().catch((error) => console.error("Gift card activation failed", error));
}, 60 * 60 * 1000);
timer.unref();

async function shutdown() {
  clearInterval(timer);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
