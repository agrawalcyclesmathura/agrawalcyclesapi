import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (e) {
      // Don't crash the whole process if the DB is briefly unreachable at boot —
      // Prisma connects lazily on the first query anyway. Keeps the app up and
      // /health/live reachable so a transient DB issue can't cause a boot crash-loop.
      this.logger.error(
        `Initial database connect failed: ${(e as Error).message}. Continuing — will retry on first query.`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect().catch(() => undefined);
  }
}
