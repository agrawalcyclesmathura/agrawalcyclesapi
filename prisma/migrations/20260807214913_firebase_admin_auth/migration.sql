-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'DISABLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "adminRequestedAt" TIMESTAMP(3),
ADD COLUMN     "adminReviewedAt" TIMESTAMP(3),
ADD COLUMN     "adminReviewedById" TEXT,
ADD COLUMN     "adminStatus" "AdminStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "firebaseUid" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE INDEX "User_adminStatus_idx" ON "User"("adminStatus");


-- Data preservation: existing STAFF accounts remain approved administrators so
-- the CMS keeps working. Their local passwords are cleared — admins now sign in
-- exclusively via Firebase (this removes the seeded `admin123` hash from the DB).
UPDATE "User"
   SET "adminStatus" = 'APPROVED',
       "adminReviewedAt" = now(),
       "passwordHash" = NULL
 WHERE "type" = 'STAFF';
