import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { notFound, param, parse } from "../lib/http";
import { staffGate } from "../lib/identity";
import { FLOW, setJobStatus } from "../services/jobs";

export const fulfilRouter = Router();
fulfilRouter.use(staffGate);

const OPEN = ["dispatched", "reprint", "cancelled"];

fulfilRouter.get("/jobs", async (req, res) => {
  const { status } = parse(z.object({ status: z.string().optional() }), req.query);
  const jobs = await prisma.printJob.findMany({
    where: status ? { status } : { status: { notIn: ["reprint", "cancelled"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  res.json(jobs);
});

fulfilRouter.get("/jobs/:id", async (req, res) => {
  const job = await prisma.printJob.findUnique({ where: { id: param(req, "id") } });
  if (!job) throw notFound("Job not on this bench");
  res.json({ ...job, flow: FLOW });
});

fulfilRouter.post("/jobs/:id/status", async (req, res) => {
  const body = parse(z.object({ status: z.string(), awb: z.string().min(4).max(40).optional(), defect: z.string().max(200).optional() }), req.body);
  res.json(await setJobStatus(param(req, "id"), body.status, body));
});

const DEFECTS = ["Colour shift", "Banding", "Frame chip", "Wrong size"];

fulfilRouter.post("/jobs/:id/qc", async (req, res) => {
  const body = parse(z.object({ result: z.enum(["pass", "fail"]), defect: z.string().max(200).default(DEFECTS[0]) }), req.body);
  res.json(await setJobStatus(param(req, "id"), body.result === "pass" ? "qc" : "reprint", { defect: body.defect }));
});

fulfilRouter.get("/reprints", async (_req, res) => {
  res.json(await prisma.printJob.findMany({ where: { OR: [{ status: "reprint" }, { priority: "rush" }] }, orderBy: { createdAt: "desc" } }));
});

fulfilRouter.get("/capacity", async (_req, res) => {
  const [config, open] = await Promise.all([prisma.config.findUniqueOrThrow({ where: { id: 1 } }), prisma.printJob.count({ where: { status: { notIn: OPEN } } })]);
  res.json({ capacity: config.capacity, holidays: config.holidays, partnerName: config.partnerName, openJobs: open });
});

fulfilRouter.put("/capacity", async (req, res) => {
  const body = parse(z.object({ capacity: z.coerce.number().int().min(1).max(100000), holidays: z.string().max(300).default("") }), req.body);
  const config = await prisma.config.update({ where: { id: 1 }, data: body });
  res.json({ capacity: config.capacity, holidays: config.holidays });
});

fulfilRouter.get("/performance", async (_req, res) => {
  const jobs = await prisma.printJob.findMany({ where: { status: { not: "cancelled" } }, select: { status: true, defect: true } });
  const total = jobs.length || 1;
  const dispatched = jobs.filter((job) => job.status === "dispatched").length;
  res.json({
    total: jobs.length,
    dispatched,
    dispatchedPercent: Math.round((dispatched / total) * 100),
    defects: jobs.filter((job) => job.status === "reprint" || job.defect).length,
    open: jobs.filter((job) => job.status !== "dispatched").length,
  });
});
