import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../lib/db";
import { badRequest, parse } from "../lib/http";
import { actorLabel, needAdmin, staffGate } from "../lib/identity";
import { createProduct, importProducts, productInclude, productSchema, updateProduct } from "../services/products";
import { csvSummary, readProductCsv } from "../services/product-csv";

export const productsRouter = Router();
productsRouter.use(staffGate, needAdmin("catalogue"));

productsRouter.get("/", async (req, res) => {
  const query = parse(z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    q: z.string().max(200).default(""),
  }), req.query);
  const where = query.q ? { OR: [{ title: { contains: query.q, mode: "insensitive" as const } }, { slug: { contains: query.q, mode: "insensitive" as const } }] } : {};
  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, include: productInclude, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
  ]);
  res.json({ total, page: query.page, limit: query.limit, items });
});

productsRouter.get("/:id", async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: String(req.params.id) }, include: productInclude });
  if (!product) throw badRequest("Product not found");
  res.json(product);
});

productsRouter.post("/", async (req, res) => {
  const input = parse(productSchema, req.body);
  res.status(201).json(await createProduct(input, actorLabel(req)));
});

productsRouter.patch("/:id", async (req, res) => {
  const input = parse(productSchema, req.body);
  res.json(await updateProduct(String(req.params.id), input, actorLabel(req)));
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single("file");
productsRouter.post("/import", csvUpload, async (req, res) => {
  const { preview } = parse(z.object({ preview: z.enum(["true", "false"]).default("true") }), req.query);
  if (!req.file) throw badRequest("Choose a CSV file");
  const parsed = readProductCsv(req.file.buffer.toString("utf8"));
  const summary = csvSummary(parsed);
  const existing = await prisma.product.findMany({ where: { slug: { in: parsed.products.map((product) => product.handle) } }, select: { slug: true } });
  for (const product of existing) {
    summary.errors.push({ row: 0, handle: product.slug, field: "Handle", message: "This product already exists; imports only create new products" });
  }
  if (preview === "true") return void res.json(summary);
  if (summary.errors.length) throw badRequest("Import validation failed. No products were imported.", summary.errors);
  const result = await importProducts(parsed.products, actorLabel(req));
  res.status(201).json({ ...result, warnings: summary.warnings });
});
