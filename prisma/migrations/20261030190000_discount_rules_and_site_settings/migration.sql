BEGIN;

ALTER TABLE "Coupon"
  ADD COLUMN "oncePerCustomer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "startsAt" TIMESTAMP(3),
  ADD COLUMN "endsAt" TIMESTAMP(3),
  ADD COLUMN "collectionSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "SiteSetting" (
  "key" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteSetting_pkey" PRIMARY KEY ("key")
);

COMMIT;
