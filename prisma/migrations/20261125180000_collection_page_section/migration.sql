-- Per-collection page footer: banner mode or related collection cards.
ALTER TABLE "Collection" ADD COLUMN "pageSectionMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Collection" ADD COLUMN "bannerEyebrow" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Collection" ADD COLUMN "bannerTitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Collection" ADD COLUMN "bannerSubtitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Collection" ADD COLUMN "bannerHref" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Collection" ADD COLUMN "bannerButtonLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Collection" ADD COLUMN "bannerImage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Collection" ADD COLUMN "relatedTitle" TEXT NOT NULL DEFAULT 'More collections';
ALTER TABLE "Collection" ADD COLUMN "relatedCollectionSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
