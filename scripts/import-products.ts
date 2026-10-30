import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { prisma } from "../src/lib/db";
import { csvSummary, readProductCsv } from "../src/services/product-csv";
import { importProducts, productInclude } from "../src/services/products";

async function main() {
  const { values } = parseArgs({ options: {
    file: { type: "string" }, replace: { type: "boolean", default: false },
    confirm: { type: "string" }, backup: { type: "string" },
    commit: { type: "boolean", default: false },
  } });
  if (!values.file) throw new Error("--file is required");
  const parsed = readProductCsv(await readFile(values.file, "utf8"));
  const summary = csvSummary(parsed);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) throw new Error("CSV validation failed; database was not changed");
  if (!values.commit) return;
  if (values.replace) {
    if (values.confirm !== "REPLACE_CATALOGUE" || !values.backup) {
      throw new Error("Replacement requires --confirm=REPLACE_CATALOGUE and --backup=<new-file.json>");
    }
    const products = await prisma.product.findMany({ include: { ...productInclude, reviews: { include: { votes: true } } } });
    const ids = products.map((product) => product.id);
    const [cart, wishlist, recent, collections] = await Promise.all([
      prisma.cartItem.findMany({ where: { productId: { in: ids } } }),
      prisma.wishlistItem.findMany({ where: { productId: { in: ids } } }),
      prisma.recentView.findMany({ where: { productId: { in: ids } } }),
      prisma.collection.findMany(),
    ]);
    await writeFile(values.backup, JSON.stringify({ at: new Date().toISOString(), products, cart, wishlist, recent, collections }, null, 2), { flag: "wx" });
    console.log("Catalogue backup saved:", values.backup);
  }
  const before = { orders: await prisma.order.count(), items: await prisma.orderItem.count(), jobs: await prisma.printJob.count() };
  console.log(await importProducts(parsed.products, "Catalogue import CLI", values.replace));
  const after = { orders: await prisma.order.count(), items: await prisma.orderItem.count(), jobs: await prisma.printJob.count() };
  console.log("Historical record counts (before / after):", before, after);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
