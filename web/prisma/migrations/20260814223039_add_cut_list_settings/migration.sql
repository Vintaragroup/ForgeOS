-- CreateTable
CREATE TABLE "cut_list_settings" (
    "id" TEXT NOT NULL,
    "defaultKerf" DECIMAL(6,3) NOT NULL DEFAULT 0.125,
    "minRemnantDimension" DECIMAL(6,3) NOT NULL DEFAULT 6,
    "dragGridSnap" DECIMAL(6,3) NOT NULL DEFAULT 0.25,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cut_list_settings_pkey" PRIMARY KEY ("id")
);

