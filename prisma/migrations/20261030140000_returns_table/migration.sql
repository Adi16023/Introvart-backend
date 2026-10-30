BEGIN;

ALTER TABLE "ReturnCase" RENAME TO "Returns";
ALTER INDEX "ReturnCase_pkey" RENAME TO "Returns_pkey";
ALTER INDEX "ReturnCase_orderId_idx" RENAME TO "Returns_orderId_idx";
ALTER TABLE "Returns" RENAME CONSTRAINT "ReturnCase_orderId_fkey" TO "Returns_orderId_fkey";

COMMIT;
