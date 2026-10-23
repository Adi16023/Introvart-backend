import type { Artist } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { SELLER_TYPES } from "./pricing";

const DAY = 86400000;

export function creatorShare(
  line: { unitPrice: number; quantity: number; fulfilment: string },
  artist: Pick<Artist, "royaltyRate" | "commissionRate">,
) {
  const gross = line.unitPrice * line.quantity;
  if (SELLER_TYPES.includes(line.fulfilment) || line.fulfilment === "commission") return Math.round(gross * (1 - artist.commissionRate));
  return Math.round(gross * artist.royaltyRate);
}

export type EarningRow = {
  orderId: string;
  itemId: string;
  title: string;
  fulfilment: string;
  status: string;
  gross: number;
  share: number;
  state: "available" | "pending" | "held" | "void";
};

// A delivered line becomes available once the return window has passed.
function stateOf(status: string, deliveredAt: Date | null): EarningRow["state"] {
  if (status === "cancelled" || status === "refunded") return "void";
  if (status === "return_requested") return "held";
  if (status !== "delivered") return "pending";
  if (!deliveredAt) return "available";
  return Date.now() - deliveredAt.getTime() >= env.returnWindowDays * DAY ? "available" : "pending";
}

export async function ledgerFor(artistId: string) {
  const artist = await prisma.artist.findUnique({ where: { id: artistId } });
  if (!artist) return null;
  const [items, commissions, payouts] = await Promise.all([
    prisma.orderItem.findMany({
      where: { creatorId: artistId, order: { paymentStatus: { in: ["paid", "cod"] } } },
      include: { order: { select: { id: true, placedAt: true } } },
      orderBy: { order: { createdAt: "desc" } },
    }),
    prisma.commission.findMany({ where: { artistId, status: "approved_final" } }),
    prisma.payout.findMany({ where: { artistId }, orderBy: { requestedAt: "desc" } }),
  ]);

  const rows: EarningRow[] = items.map((item) => ({
    orderId: item.orderId,
    itemId: item.id,
    title: item.title,
    fulfilment: item.fulfilment,
    status: item.status,
    gross: item.unitPrice * item.quantity,
    share: creatorShare(item, artist),
    state: stateOf(item.status, item.deliveredAt),
  }));
  for (const commission of commissions) {
    const price = (commission.quote as { price?: number } | null)?.price ?? commission.paid;
    rows.push({
      orderId: commission.id,
      itemId: commission.id,
      title: `Commission · ${commission.medium}`,
      fulfilment: "commission",
      status: commission.status,
      gross: price,
      share: Math.round(price * (1 - artist.commissionRate)),
      state: "available",
    });
  }

  const sum = (state: EarningRow["state"]) => rows.filter((row) => row.state === state).reduce((total, row) => total + row.share, 0);
  const released = payouts.filter((p) => p.status === "released").reduce((total, p) => total + p.amount, 0);
  const requested = payouts.filter((p) => p.status === "requested").reduce((total, p) => total + p.amount, 0);
  const available = sum("available");
  return {
    artist,
    rows,
    payouts,
    totals: {
      available,
      pending: sum("pending"),
      held: sum("held"),
      released,
      requested,
      withdrawable: Math.max(0, available - released - requested),
    },
  };
}
