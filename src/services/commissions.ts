import type { Commission } from "@prisma/client";
import { json, transaction } from "../lib/db";
import { badRequest, conflict, forbidden, notFound } from "../lib/http";

type Progress = { at: string; text: string };

const shortDate = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const progressOf = (commission: Commission) => (commission.progress as Progress[]) ?? [];
const note = (commission: Commission, text: string) => json([{ at: shortDate(), text }, ...progressOf(commission)]);

async function load(tx: Parameters<Parameters<typeof transaction>[0]>[0], id: string) {
  const commission = await tx.commission.findUnique({ where: { id } });
  if (!commission) throw notFound("Commission not found");
  return commission;
}

function ownedBy(commission: Commission, ownerId: string) {
  if (commission.ownerId !== ownerId) throw forbidden("This request belongs to someone else");
}

function ownedByArtist(commission: Commission, artistId: string) {
  if (commission.artistId !== artistId) throw forbidden("This request is not in your studio");
}

function expect(commission: Commission, allowed: string[], action: string) {
  if (!allowed.includes(commission.status)) throw conflict(`Cannot ${action} while the request is ${commission.status.replaceAll("_", " ")}`);
}

export const commissions = {
  async sendQuote(id: string, artistId: string, quote: { price: number; timeline: string; revisions: number }) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedByArtist(c, artistId);
      expect(c, ["requested", "quoted"], "quote");
      return tx.commission.update({ where: { id }, data: { quote: json(quote), status: "quoted", progress: note(c, `Quote sent: ₹${quote.price.toLocaleString("en-IN")}`) } });
    });
  },

  async creatorDecline(id: string, artistId: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedByArtist(c, artistId);
      expect(c, ["requested", "quoted"], "decline");
      return tx.commission.update({ where: { id }, data: { status: "declined", progress: note(c, "Declined by the artist") } });
    });
  },

  // Customer accepts the quote and half of it is held by the platform.
  async accept(id: string, ownerId: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedBy(c, ownerId);
      expect(c, ["quoted"], "accept");
      const quote = c.quote as { price: number } | null;
      if (!quote) throw badRequest("No quote to accept");
      const artist = await tx.artist.findUnique({ where: { id: c.artistId } });
      if (artist && artist.slots <= 0) throw conflict("The artist has no open slots right now");
      await tx.artist.updateMany({ where: { id: c.artistId, slots: { gt: 0 } }, data: { slots: { decrement: 1 } } });
      return tx.commission.update({
        where: { id },
        data: { status: "accepted", paid: Math.round(quote.price / 2), progress: note(c, "Advance held") },
      });
    });
  },

  async declineQuote(id: string, ownerId: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedBy(c, ownerId);
      expect(c, ["requested", "quoted"], "decline");
      return tx.commission.update({ where: { id }, data: { status: "declined", progress: note(c, "Declined by the customer") } });
    });
  },

  async postProgress(id: string, artistId: string, text: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedByArtist(c, artistId);
      expect(c, ["accepted", "in_progress", "revision"], "post progress");
      return tx.commission.update({ where: { id }, data: { status: "in_progress", progress: note(c, text) } });
    });
  },

  async dispatch(id: string, artistId: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedByArtist(c, artistId);
      expect(c, ["in_progress", "revision"], "dispatch");
      return tx.commission.update({ where: { id }, data: { status: "shipped", progress: note(c, "Packed and handed to the courier") } });
    });
  },

  async requestRevision(id: string, ownerId: string, message: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedBy(c, ownerId);
      expect(c, ["in_progress", "shipped"], "request a revision");
      const allowed = (c.quote as { revisions?: number } | null)?.revisions ?? 0;
      if (c.revisionsUsed >= allowed) throw conflict("All revisions included in the quote are used");
      return tx.commission.update({
        where: { id },
        data: { status: "revision", revisionsUsed: { increment: 1 }, progress: note(c, message || "Please revise") },
      });
    });
  },

  // Approving the final piece releases the full price to the artist's ledger.
  async approveFinal(id: string, ownerId: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      ownedBy(c, ownerId);
      expect(c, ["in_progress", "revision", "shipped"], "approve");
      const price = (c.quote as { price?: number } | null)?.price ?? c.paid;
      return tx.commission.update({ where: { id }, data: { status: "approved_final", paid: price, progress: note(c, "Final approved") } });
    });
  },

  async message(id: string, ownerId: string | null, artistId: string | null, text: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      if (ownerId) ownedBy(c, ownerId);
      if (artistId) ownedByArtist(c, artistId);
      return tx.commission.update({ where: { id }, data: { progress: note(c, text) } });
    });
  },

  async cancelByAdmin(id: string, reason: string) {
    return transaction(async (tx) => {
      const c = await load(tx, id);
      expect(c, ["requested", "quoted", "accepted", "in_progress", "revision", "shipped"], "cancel");
      if (c.paid > 0 && c.ownerId && !c.ownerId.startsWith("guest:")) {
        await tx.customer.updateMany({ where: { id: c.ownerId }, data: { credit: { increment: c.paid } } });
      }
      if (["accepted", "in_progress", "revision", "shipped"].includes(c.status)) {
        await tx.artist.update({ where: { id: c.artistId }, data: { slots: { increment: 1 } } });
      }
      return tx.commission.update({ where: { id }, data: { status: "cancelled", paid: 0, progress: note(c, reason) } });
    });
  },
};
