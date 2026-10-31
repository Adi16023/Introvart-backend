BEGIN;

ALTER TABLE "Order" ADD COLUMN "shippingBlocked" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ShippingWarehouse" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner" TEXT NOT NULL UNIQUE,
  "velocityId" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "contactPerson" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ShippingShipment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookingKey" TEXT NOT NULL UNIQUE,
  "orderId" TEXT NOT NULL REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "itemId" TEXT NOT NULL,
  "jobId" TEXT,
  "returnCaseId" TEXT,
  "creatorId" TEXT,
  "warehouseId" TEXT NOT NULL,
  "journey" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'creating',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "remoteOrderId" TEXT,
  "remoteShipmentId" TEXT,
  "remoteReturnId" TEXT,
  "awb" TEXT UNIQUE,
  "carrierId" TEXT,
  "carrierName" TEXT,
  "labelUrl" TEXT,
  "labelKey" TEXT,
  "trackingUrl" TEXT,
  "length" DOUBLE PRECISION NOT NULL,
  "width" DOUBLE PRECISION NOT NULL,
  "height" DOUBLE PRECISION NOT NULL,
  "weightGrams" DOUBLE PRECISION NOT NULL,
  "codAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "request" JSONB NOT NULL,
  "charges" JSONB NOT NULL DEFAULT '{}',
  "tracking" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "syncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ShippingShipment_orderId_idx" ON "ShippingShipment"("orderId");
CREATE INDEX "ShippingShipment_creatorId_idx" ON "ShippingShipment"("creatorId");
CREATE INDEX "ShippingShipment_state_updatedAt_idx" ON "ShippingShipment"("state", "updatedAt");

COMMIT;
