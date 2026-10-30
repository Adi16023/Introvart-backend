BEGIN;

DROP VIEW "Artwork";

ALTER TABLE "products" RENAME TO "Products";
ALTER INDEX "products_pkey" RENAME TO "Products_pkey";
ALTER INDEX "products_slug_key" RENAME TO "Products_slug_key";
ALTER INDEX "products_artistId_status_idx" RENAME TO "Products_artistId_status_idx";
ALTER INDEX "products_status_idx" RENAME TO "Products_status_idx";
ALTER TABLE "Products" RENAME CONSTRAINT "products_artistId_fkey" TO "Products_artistId_fkey";

ALTER TABLE "CartItem" RENAME COLUMN "artworkId" TO "productId";
ALTER TABLE "WishlistItem" RENAME COLUMN "artworkId" TO "productId";
ALTER TABLE "RecentView" RENAME COLUMN "artworkId" TO "productId";
ALTER TABLE "Review" RENAME COLUMN "artworkId" TO "productId";
ALTER TABLE "OrderItem" RENAME COLUMN "artworkId" TO "productId";
ALTER TABLE "Review" RENAME CONSTRAINT "Review_artworkId_fkey" TO "Review_productId_fkey";
ALTER INDEX "Review_artworkId_status_idx" RENAME TO "Review_productId_status_idx";

ALTER TABLE "Customer"
  ADD COLUMN "addresses" JSONB NOT NULL DEFAULT '[]';

UPDATE "Customer" AS customer
SET "addresses" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', address."id",
        'customerId', address."customerId",
        'name', address."name",
        'phone', address."phone",
        'line', address."line",
        'city', address."city",
        'state', address."state",
        'pincode', address."pincode",
        'label', address."label",
        'createdAt', to_char(address."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      ORDER BY address."createdAt" DESC, address."id"
    )
    FROM "Address" AS address
    WHERE address."customerId" = customer."id"
  ),
  '[]'::jsonb
);

ALTER TABLE "Review"
  ADD COLUMN "votes" JSONB NOT NULL DEFAULT '[]';

UPDATE "Review" AS review
SET "votes" = COALESCE(
  (
    SELECT jsonb_agg(vote."ownerId" ORDER BY vote."ownerId")
    FROM "ReviewVote" AS vote
    WHERE vote."reviewId" = review."id"
  ),
  '[]'::jsonb
);

DROP TABLE "Address";
DROP TABLE "ReviewVote";

ALTER TABLE "StaffUser" RENAME TO "Admin";
ALTER INDEX "StaffUser_pkey" RENAME TO "Admin_pkey";
ALTER INDEX "StaffUser_email_key" RENAME TO "Admin_email_key";

ALTER TABLE "SearchLog" RENAME TO "SearchHistory";
ALTER INDEX "SearchLog_pkey" RENAME TO "SearchHistory_pkey";
ALTER INDEX "SearchLog_createdAt_idx" RENAME TO "SearchHistory_createdAt_idx";
ALTER SEQUENCE "SearchLog_id_seq" RENAME TO "SearchHistory_id_seq";

ALTER TABLE "SavedDesign" RENAME TO "Saved";
ALTER INDEX "SavedDesign_pkey" RENAME TO "Saved_pkey";
ALTER INDEX "SavedDesign_ownerId_idx" RENAME TO "Saved_ownerId_idx";

ALTER TABLE "AuditLog" RENAME TO "Activity";
ALTER INDEX "AuditLog_pkey" RENAME TO "Activity_pkey";
ALTER INDEX "AuditLog_at_idx" RENAME TO "Activity_at_idx";

COMMIT;
