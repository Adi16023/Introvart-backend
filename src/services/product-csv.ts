import { parse as parseCsv } from "csv-parse/sync";
import { productSchema, type ProductInput } from "./products";
import { badRequest } from "../lib/http";

export type CsvIssue = { row: number; handle: string; field: string; message: string };
export type ProductCsv = {
  products: ProductInput[];
  errors: CsvIssue[];
  headers: string[];
  rowCount: number;
};

function numberValue(value: string, field: string, nullable = false): number | null {
  if (!value.trim()) return nullable ? null : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a number`);
  return parsed;
}

function booleanValue(value: string, field: string, fallback: boolean) {
  if (!value.trim()) return fallback;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new Error(`${field} must be true or false`);
}

export function readProductCsv(csv: string): ProductCsv {
  let headers: string[] = [];
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(csv, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 500_000,
      columns: (columns: string[]) => {
        headers = columns.map((column) => column.trim());
        if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV column names");
        return headers;
      },
    });
  } catch (error) {
    throw badRequest(`Invalid CSV: ${error instanceof Error ? error.message : "Unable to parse CSV"}`);
  }
  for (const required of ["Handle", "Title", "Variant Price", "Image Src"]) {
    if (!headers.includes(required)) throw badRequest(`Missing CSV column: ${required}`);
  }
  if (!rows.length || rows.length > 10_000) throw badRequest("Supply between 1 and 10,000 CSV rows");
  const groups = new Map<string, { row: Record<string, string>; number: number }[]>();
  const errors: CsvIssue[] = [];
  rows.forEach((row, index) => {
    const handle = row.Handle.trim();
    if (!handle) errors.push({ row: index + 2, handle: "", field: "Handle", message: "Handle is required on every row" });
    else {
      const group = groups.get(handle) ?? [];
      group.push({ row, number: index + 2 });
      groups.set(handle, group);
    }
  });
  if (groups.size > 1000) throw badRequest("Import at most 1000 products at once");
  const products: ProductInput[] = [];
  for (const [handle, group] of groups) {
    const first = group[0].row;
    try {
      const get = (key: string) => first[key] ?? "";
      const optionIndexes = [1, 2, 3].filter((index) => get(`Option${index} Name`).trim());
      const options = optionIndexes.map((index) => ({ name: get(`Option${index} Name`).trim(), linkedTo: get(`Option${index} Linked To`) }));
      const images = group.filter(({ row }) => row["Image Src"]?.trim()).map(({ row }, index) => ({
        src: row["Image Src"].trim(),
        position: numberValue(row["Image Position"] || String(index + 1), "Image Position"),
        alt: row["Image Alt Text"] || "",
      }));
      const variants = group.filter(({ row, number }) => {
        if (row["Variant Price"]?.trim()) return true;
        if ([1, 2, 3].some((index) => row[`Option${index} Value`]?.trim()) || row["Variant SKU"]?.trim()) {
          errors.push({ row: number, handle, field: "Variant Price", message: "Variant price is required" });
        }
        return false;
      }).map(({ row, number }) => {
        const val = (key: string) => row[key] || "";
        try {
          return {
            optionValues: optionIndexes.map((index) => val(`Option${index} Value`)),
            sku: val("Variant SKU"), barcode: val("Variant Barcodes") || val("Variant Barcode"),
            price: numberValue(val("Variant Price"), "Variant Price"),
            compareAtPrice: numberValue(val("Variant Compare At Price"), "Variant Compare At Price", true),
            inventoryTracker: val("Variant Inventory Tracker"),
            inventoryQuantity: numberValue(val("Variant Inventory Qty"), "Variant Inventory Qty"),
            inventoryPolicy: val("Variant Inventory Policy") || "deny",
            fulfillmentService: val("Variant Fulfillment Service") || "manual",
            requiresShipping: booleanValue(val("Variant Requires Shipping"), "Variant Requires Shipping", true),
            taxable: booleanValue(val("Variant Taxable"), "Variant Taxable", true),
            grams: numberValue(val("Variant Grams"), "Variant Grams"),
            weightUnit: val("Variant Weight Unit") || "kg",
            image: val("Variant Image"), taxCode: val("Variant Tax Code"),
            costPerItem: numberValue(val("Cost per item"), "Cost per item", true),
            unitPriceMeasure: Object.fromEntries(headers.filter((header) => header.startsWith("Unit Price ")).map((header) => [header, val(header)])),
            packedLength: numberValue(val("Variant Packed Length"), "Variant Packed Length", true),
            packedWidth: numberValue(val("Variant Packed Width"), "Variant Packed Width", true),
            packedHeight: numberValue(val("Variant Packed Height"), "Variant Packed Height", true),
            packedDimensionUnit: val("Variant Packed Dimension Unit"),
          };
        } catch (error) {
          throw new Error(`CSV row ${number}: ${error instanceof Error ? error.message : "Invalid variant"}`);
        }
      });
      const result = productSchema.safeParse({
        handle, title: get("Title"), vendor: get("Vendor"), descriptionHtml: get("Body (HTML)"),
        category: get("Product Category"), productType: get("Type"),
        tags: get("Tags").split(",").map((tag) => tag.trim()).filter(Boolean),
        published: booleanValue(get("Published"), "Published", true),
        catalogStatus: get("Status").toLowerCase() || "draft",
        giftCard: booleanValue(get("Gift Card"), "Gift Card", false),
        seoTitle: get("SEO Title"), seoDescription: get("SEO Description"),
        options, images, variants,
        metafields: Object.fromEntries(headers.filter((header) => header.includes("(product.metafields.")).map((header) => [header, get(header)])),
        googleShopping: Object.fromEntries(headers.filter((header) => header.startsWith("Google Shopping /")).map((header) => [header, get(header)])),
        sourceRows: group.map(({ row }) => row),
      });
      if (!result.success) {
        for (const issue of result.error.issues) {
          const variantIndex = issue.path[0] === "variants" && typeof issue.path[1] === "number" ? issue.path[1] : null;
          const variantRows = group.filter(({ row }) => row["Variant Price"]?.trim());
          errors.push({
            row: variantIndex === null ? group[0].number : variantRows[variantIndex]?.number ?? group[0].number,
            handle, field: issue.path.join("."), message: issue.message,
          });
        }
      } else products.push(result.data);
    } catch (error) {
      errors.push({ row: group[0].number, handle, field: "CSV", message: error instanceof Error ? error.message : "Invalid product" });
    }
  }
  return { products, errors, headers, rowCount: rows.length };
}

export function csvSummary(parsed: ProductCsv) {
  return {
    rows: parsed.rowCount, products: parsed.products.length,
    variants: parsed.products.reduce((count, product) => count + product.variants.length, 0),
    images: parsed.products.reduce((count, product) => count + product.images.length, 0),
    columns: parsed.headers, errors: parsed.errors,
    items: parsed.products.map((product) => ({
      handle: product.handle, title: product.title, vendor: product.vendor,
      status: product.catalogStatus, published: product.published,
      variants: product.variants.length, images: product.images.length,
      minPrice: Math.min(...product.variants.map((variant) => variant.price)),
      maxPrice: Math.max(...product.variants.map((variant) => variant.price)),
    })),
    warnings: ["Images remain hosted at their source HTTPS URLs; this import does not copy files.",
      "All original columns are preserved in sourceRows, including blank values.",
      "A blank inventory tracker means inventory is not tracked, even if quantity is zero or negative.",
      "Gift Card products are catalogue entries only; voucher issuance uses the existing gift-card workflow."],
  };
}
