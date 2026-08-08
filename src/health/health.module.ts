import { Module, Controller, Get, HttpCode, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { Public } from "../auth/decorators";

@Injectable()
class HealthService {
  constructor(
    private prisma: PrismaService,
    @Inject(REDIS) private redis: Redis,
  ) {}

  async check() {
    const [db, cache] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => "up").catch(() => "down"),
      this.redis.ping().then(() => "up").catch(() => "down"),
    ]);
    const status = db === "up" && cache === "up" ? "ok" : "degraded";
    return {
      status,
      services: { database: db, redis: cache },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: are downstream dependencies reachable? Throws 503 when not. */
  async ready() {
    const result = await this.check();
    if (result.status !== "ok") {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}

@ApiTags("health")
@Controller({ path: "health", version: "1" })
class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @ApiOperation({ summary: "Full health report (DB + Redis + uptime)" })
  @Get()
  check() {
    return this.health.check();
  }

  @Public()
  @ApiOperation({ summary: "Liveness probe — process is up (no dependency checks)" })
  @Get("live")
  live() {
    return { status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Public()
  @ApiOperation({ summary: "Readiness probe — 200 when DB + Redis are reachable, else 503" })
  @HttpCode(200)
  @Get("ready")
  ready() {
    return this.health.ready();
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
