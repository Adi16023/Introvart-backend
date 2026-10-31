CREATE TABLE "VelocityAssignment" (
    "shipmentId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "awb" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VelocityAssignment_pkey" PRIMARY KEY ("shipmentId")
);
