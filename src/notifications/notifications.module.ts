import {
  Module, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsBooleanString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, type AuthUser } from "../auth/decorators";

// ---- Types --------------------------------------------------------------

export interface NotificationPayload {
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

class ListNotificationsDto {
  @ApiPropertyOptional({ description: "Pagination cursor (id of the last item seen)." })
  @IsOptional() @IsUUID("4") cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional() @IsInt() @Min(1) @Max(50) limit?: number;

  @ApiPropertyOptional({ description: "true → only unread." })
  @IsOptional() @IsBooleanString() unread?: string;
}

// ---- Service ------------------------------------------------------------

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a notification for a single user. */
  async emitToUser(userId: string, payload: NotificationPayload) {
    return this.prisma.notification.create({
      data: {
        userId,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        data: (payload.data as object) ?? undefined,
      },
    });
  }

  /**
   * Fan-out an admin notification to every active staff member (one row each,
   * so read-state is per-user). Safe no-op when there are no staff. Never throws
   * into the calling flow — notification failures must not break the triggering action.
   */
  async emitToStaff(payload: NotificationPayload): Promise<{ count: number }> {
    try {
      const staff = await this.prisma.user.findMany({
        where: { type: "STAFF", isActive: true },
        select: { id: true },
      });
      if (!staff.length) return { count: 0 };
      await this.prisma.notification.createMany({
        data: staff.map((s) => ({
          userId: s.id,
          type: payload.type,
          title: payload.title,
          body: payload.body,
          data: (payload.data as object) ?? undefined,
        })),
      });
      return { count: staff.length };
    } catch {
      return { count: 0 };
    }
  }

  /** Cursor-paginated feed for the current user (newest first). */
  async list(userId: string, opts: { cursor?: string; limit?: number; unread?: boolean }) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const where = { userId, ...(opts.unread ? { isRead: false } : {}) };
    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  }

  unreadCount(userId: string) {
    return this.prisma.notification
      .count({ where: { userId, isRead: false } })
      .then((count) => ({ count }));
  }

  async markRead(id: string, userId: string) {
    // Scoped update — a user can only mark their own notifications.
    const res = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    if (!res.count) throw new NotFoundException("Notification not found");
    return { success: true, id };
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { success: true, count: res.count };
  }
}

// ---- Controller (authenticated; feed scoped to the current user) --------

@ApiTags("notifications")
@ApiBearerAuth()
@Controller({ path: "notifications", version: "1" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiOperation({ summary: "The current user's notification feed (cursor-paginated)" })
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListNotificationsDto) {
    return this.notifications.list(user.sub, {
      cursor: q.cursor,
      limit: q.limit,
      unread: q.unread === "true",
    });
  }

  @ApiOperation({ summary: "Unread count for the notification badge" })
  @Get("unread-count")
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.sub);
  }

  @ApiOperation({ summary: "Mark one notification read" })
  @Patch(":id/read")
  markRead(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(id, user.sub);
  }

  @ApiOperation({ summary: "Mark all of the current user's notifications read" })
  @Post("read-all")
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.sub);
  }
}

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
