import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 no longer reads DATABASE_URL from the schema's datasource block
// at runtime -- the client needs an explicit driver adapter. See
// prisma/schema.prisma's datasource comment and
// https://pris.ly/d/prisma7-client-config.
const adapter = new PrismaPg(process.env.DATABASE_URL!);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
