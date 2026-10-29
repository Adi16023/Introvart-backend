import type { ProductVariant } from "@prisma/client";
import { badRequest } from "../lib/http";

export function variantAvailable(variant: Pick<ProductVariant, "inventoryTracker" | "inventoryPolicy" | "inventoryQuantity">, quantity = 1) {
  return !variant.inventoryTracker || variant.inventoryPolicy === "continue" || variant.inventoryQuantity >= quantity;
}

export function selectedVariant(variants: ProductVariant[], variantId?: string | null) {
  if (!variants.length) {
    if (variantId) throw badRequest("This product has no variants");
    return null;
  }
  const found = variants.find((variant) => variant.id === variantId);
  if (!found) throw badRequest("Choose a valid product variant");
  return found;
}

export const variantLabel = (variant: Pick<ProductVariant, "optionValues">) => variant.optionValues.join(" / ") || "Default";
