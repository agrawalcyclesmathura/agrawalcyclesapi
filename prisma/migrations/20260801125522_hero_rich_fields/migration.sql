-- AlterTable
ALTER TABLE "Banner" ADD COLUMN     "alignment" TEXT NOT NULL DEFAULT 'center',
ADD COLUMN     "animation" JSONB,
ADD COLUMN     "badge" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "overlayOpacity" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "secondaryText" TEXT,
ADD COLUMN     "secondaryUrl" TEXT,
ADD COLUMN     "theme" TEXT NOT NULL DEFAULT 'light',
ADD COLUMN     "videoUrl" TEXT;
