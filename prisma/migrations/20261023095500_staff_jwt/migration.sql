CREATE TYPE "StaffRole" AS ENUM ('moderator', 'support', 'operations', 'finance', 'marketing', 'super', 'creator');

CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "creatorId" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

CREATE TABLE "StaffSigningKey" (
    "id" INTEGER NOT NULL,
    "privateKey" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffSigningKey_pkey" PRIMARY KEY ("id")
);
