import { transaction } from "../lib/db";
import { badRequest, conflict, notFound, uid } from "../lib/http";
import { prisma } from "../lib/db";
import { ensureDispatchAwb } from "./shipping";

export const FLOW = ["accepted", "printing", "framing", "qc", "packing", "ready", "dispatched"] as const;

const ITEM_STATUS: Record<string, string> = {
  accepted: "accepted",
  printing: "in_production",
  framing: "in_production",
  qc: "qc",
  packing: "packed",
  ready: "packed",
  dispatched: "shipped",
};

export async function setJobStatus(jobId: string, status: string, extra: { defect?: string; awb?: string } = {}) {
  if (status !== "reprint" && !(FLOW as readonly string[]).includes(status)) {
    throw badRequest(`Status must be one of ${[...FLOW, "reprint"].join(", ")}`);
  }
  if (status === "dispatched") {
    const job = await prisma.printJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound("Job not found");
    extra = { ...extra, awb: await ensureDispatchAwb(job.itemId, job.id, extra.awb) };
  }
  return transaction(async (tx) => {
    const job = await tx.printJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound("Job not found");
    if (job.status === "cancelled") throw conflict("This job was cancelled with its order");
    if (job.status === "dispatched" && status !== "reprint") throw conflict("Already dispatched");

    if (status === "reprint") {
      const updated = await tx.printJob.update({ where: { id: jobId }, data: { status: "reprint", defect: extra.defect ?? "QC fail" } });
      await tx.printJob.create({
        data: {
          id: uid("JOB"),
          orderId: job.orderId,
          itemId: job.itemId,
          title: job.title,
          image: job.image,
          spec: job.spec,
          quantity: job.quantity,
          status: "new",
          priority: "rush",
          due: job.due,
          giftSlip: job.giftSlip,
        },
      });
      return updated;
    }

    const awb = status === "dispatched" ? extra.awb || job.awb : job.awb;
    if (status === "dispatched" && !awb) throw badRequest("Book the parcel in Velocity or enter a real external courier AWB before dispatching.");
    const updated = await tx.printJob.update({
      where: { id: jobId },
      data: { status, defect: extra.defect ?? job.defect, awb, ...(status === "dispatched" ? { ndr: "clear" } : {}) },
    });
    const itemStatus = ITEM_STATUS[status];
    await tx.orderItem.updateMany({
      where: { id: job.itemId, orderId: job.orderId, status: { notIn: ["delivered", "cancelled", "refunded"] } },
      data: { status: itemStatus, ...(status === "dispatched" ? { awb } : {}) },
    });
    return updated;
  });
}
