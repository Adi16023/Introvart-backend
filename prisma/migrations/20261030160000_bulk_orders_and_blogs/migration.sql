BEGIN;

ALTER TABLE "B2BLead" RENAME TO "BulkOrders";
ALTER INDEX "B2BLead_pkey" RENAME TO "BulkOrders_pkey";

ALTER TABLE "Post" RENAME TO "Blogs";
ALTER INDEX "Post_pkey" RENAME TO "Blogs_pkey";

COMMIT;
