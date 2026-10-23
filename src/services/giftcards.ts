import crypto from "node:crypto";
import { prisma } from "../lib/db";
import { notFound, uid } from "../lib/http";

function dueNow(sendOn: string) {
  if (!sendOn || sendOn.toLowerCase() === "now") return true;
  const when = Date.parse(sendOn);
  return Number.isNaN(when) ? true : when <= Date.now();
}

export async function issueGiftCard(input: {
  amount: number;
  from: string;
  to: string;
  email: string;
  message?: string;
  theme: string;
  sendOn?: string;
}) {
  const letters = input.theme.replace(/[^a-z]/gi, "").slice(0, 4).toUpperCase() || "GIFT";
  const sendOn = input.sendOn?.trim() || "Now";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `IV-${letters}-${crypto.randomInt(1000, 10000)}`;
    if (await prisma.giftCard.findUnique({ where: { code } })) continue;
    return prisma.giftCard.create({
      data: {
        id: uid("GC"),
        code,
        amount: input.amount,
        balance: input.amount,
        from: input.from,
        to: input.to,
        email: input.email,
        message: input.message ?? "",
        theme: input.theme,
        sendOn,
        status: dueNow(sendOn) ? "active" : "scheduled",
      },
    });
  }
  throw new Error("Could not allocate a gift card code");
}

// Scheduled cards go live on their send date.
export async function activateDueGiftCards() {
  const scheduled = await prisma.giftCard.findMany({ where: { status: "scheduled" } });
  const due = scheduled.filter((card) => dueNow(card.sendOn)).map((card) => card.id);
  if (due.length) await prisma.giftCard.updateMany({ where: { id: { in: due } }, data: { status: "active" } });
  return due.length;
}

export async function balanceOf(code: string) {
  await activateDueGiftCards();
  const card = await prisma.giftCard.findFirst({ where: { code: { equals: code.trim(), mode: "insensitive" } } });
  if (!card) throw notFound("No gift card with that code");
  return { code: card.code, balance: card.balance, amount: card.amount, status: card.status };
}
