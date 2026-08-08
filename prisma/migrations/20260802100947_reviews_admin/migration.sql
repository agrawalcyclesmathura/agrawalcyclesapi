-- AlterEnum
ALTER TYPE "ReviewStatus" ADD VALUE 'SPAM';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "media" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "repliedById" TEXT,
ADD COLUMN     "reply" TEXT;

-- CreateIndex
CREATE INDEX "Review_deletedAt_idx" ON "Review"("deletedAt");
