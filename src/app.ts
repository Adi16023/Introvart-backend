import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./lib/env";
import { prisma } from "./lib/db";
import { errorHandler } from "./lib/http";
import { identify } from "./lib/identity";
import { adminRouter } from "./routes/admin";
import { adminContentRouter } from "./routes/adminContent";
import { creatorRouter } from "./routes/creator";
import { fulfilRouter } from "./routes/fulfil";
import { mediaRouter } from "./routes/media";
import { publicRouter } from "./routes/public";
import { shopRouter } from "./routes/shop";
import { staffAuthRouter } from "./routes/staffAuth";
import { productsRouter } from "./routes/products";

export function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : true,
      allowedHeaders: ["Content-Type", "Authorization", "x-customer-id", "x-guest-id", "x-creator-id", "x-admin-role", "x-admin-name", "x-staff-key"],
      maxAge: 600,
    }),
  );
  // Uploads go through POST /uploads (multipart); JSON bodies only carry references and text.
  app.use(express.json({ limit: "1mb" }));
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`select 1`;
      res.json({ ok: true, db: "up" });
    } catch {
      res.status(503).json({ ok: false, db: "down" });
    }
  });

  const api = express.Router();
  api.use(identify);
  api.use("/auth", staffAuthRouter);
  api.use("/admin/products", productsRouter);
  api.use("/creator", creatorRouter);
  api.use("/admin", adminRouter, adminContentRouter);
  api.use("/fulfil", fulfilRouter);
  api.use(mediaRouter);
  api.use(publicRouter);
  api.use(shopRouter);
  app.use("/api/v1", api);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);
  return app;
}
