BEGIN;

ALTER TABLE "Products"
  ADD COLUMN "images" JSONB NOT NULL DEFAULT '[]';

UPDATE "Products" AS product
SET "images" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'src', image."src",
        'position', image."position",
        'alt', image."alt"
      )
      ORDER BY image."position"
    )
    FROM "ProductImage" AS image
    WHERE image."productId" = product."id"
  ),
  CASE
    WHEN product."image" <> '' THEN jsonb_build_array(
      jsonb_build_object('src', product."image", 'position', 1, 'alt', product."title")
    )
    ELSE '[]'::jsonb
  END
);

DROP TABLE "ProductImage";

COMMIT;
