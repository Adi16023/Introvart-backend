-- Keep the Prisma Artwork model/API compatible while renaming the stored table.
BEGIN;
ALTER TABLE "Artwork" RENAME TO "products";
ALTER INDEX "Artwork_pkey" RENAME TO "products_pkey";
ALTER INDEX "Artwork_slug_key" RENAME TO "products_slug_key";
ALTER INDEX "Artwork_artistId_status_idx" RENAME TO "products_artistId_status_idx";
ALTER INDEX "Artwork_status_idx" RENAME TO "products_status_idx";
ALTER TABLE "products" RENAME CONSTRAINT "Artwork_artistId_fkey" TO "products_artistId_fkey";

ALTER TABLE "products"
  ADD COLUMN "vendor" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "productType" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "descriptionHtml" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "catalogStatus" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "giftCard" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "seoTitle" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "seoDescription" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "options" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "metafields" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "googleShopping" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sourceRows" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "ProductVariant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "optionValues" TEXT[] NOT NULL,
  "sku" TEXT NOT NULL DEFAULT '',
  "barcode" TEXT NOT NULL DEFAULT '',
  "price" DOUBLE PRECISION NOT NULL,
  "compareAtPrice" DOUBLE PRECISION,
  "inventoryTracker" TEXT NOT NULL DEFAULT '',
  "inventoryQuantity" INTEGER NOT NULL DEFAULT 0,
  "inventoryPolicy" TEXT NOT NULL DEFAULT 'deny',
  "fulfillmentService" TEXT NOT NULL DEFAULT 'manual',
  "requiresShipping" BOOLEAN NOT NULL DEFAULT true,
  "taxable" BOOLEAN NOT NULL DEFAULT true,
  "grams" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "weightUnit" TEXT NOT NULL DEFAULT 'kg',
  "image" TEXT NOT NULL DEFAULT '',
  "taxCode" TEXT NOT NULL DEFAULT '',
  "costPerItem" DOUBLE PRECISION,
  "unitPriceMeasure" JSONB NOT NULL DEFAULT '{}',
  "packedLength" DOUBLE PRECISION,
  "packedWidth" DOUBLE PRECISION,
  "packedHeight" DOUBLE PRECISION,
  "packedDimensionUnit" TEXT NOT NULL DEFAULT '',
  "sort" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

CREATE TABLE "ProductImage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "src" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 1,
  "alt" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX "ProductImage_productId_position_key" ON "ProductImage"("productId", "position");
ALTER TABLE "CartItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT, ADD COLUMN "sku" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OrderItem" ALTER COLUMN "unitPrice" TYPE DOUBLE PRECISION;
ALTER TABLE "Order" ALTER COLUMN "subtotal" TYPE DOUBLE PRECISION,
  ALTER COLUMN "payable" TYPE DOUBLE PRECISION,
  ALTER COLUMN "giftCardAmount" TYPE DOUBLE PRECISION,
  ALTER COLUMN "creditUsed" TYPE DOUBLE PRECISION,
  ALTER COLUMN "refunded" TYPE DOUBLE PRECISION;
ALTER TABLE "Customer" ALTER COLUMN "credit" TYPE DOUBLE PRECISION;
ALTER TABLE "GiftCard" ALTER COLUMN "balance" TYPE DOUBLE PRECISION;

-- Old deployed clients can continue reading/writing during the backend rollout.
-- The physical catalogue table is products; this is an automatically updatable view.
CREATE VIEW "Artwork" AS SELECT * FROM "products";
COMMIT;
