import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "../auth/decorators";

/** Serialize arbitrary values (Decimal, Date, etc.) into JSON-safe payloads. */
function jsonSafe(value: unknown): any {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export interface AuditParams {
  actor?: Pick<AuthUser, "sub" | "email"> | null;
  action: string; // e.g. "settings.update", "banner.create"
  entity: string; // e.g. "Setting", "Banner"
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/**
 * Central write path for the admin activity feed (ActivityLog) and the immutable
 * audit trail (AuditLog). Every mutating admin action should call `record`.
 */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async record(params: AuditParams): Promise<void> {
    const { actor, action, entity, entityId, before, after, ip } = params;
    try {
      await this.prisma.$transaction([
        this.prisma.activityLog.create({
          data: {
            userId: actor?.sub ?? null,
            action,
            entity,
            entityId: entityId ?? null,
            ip: ip ?? null,
          },
        }),
        this.prisma.auditLog.create({
          data: {
            actor: actor?.email ?? actor?.sub ?? "system",
            action,
            entity,
            entityId: entityId ?? null,
            before: jsonSafe(before),
            after: jsonSafe(after),
          },
        }),
      ]);
    } catch {
      // Auditing must never break the primary operation.
    }
  }
}
