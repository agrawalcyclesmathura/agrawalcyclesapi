import { Module } from "@nestjs/common";
import {
  Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength,
} from "class-validator";
import { OrderStatus, type Prisma } from "@prisma/client";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, RequirePermissions, type AuthUser } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

const uuid = () => new ParseUUIDPipe({ version: "4" });
const SPENT_STATUSES = { notIn: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] };

// =========================================================================
// CUSTOMER GROUPS — standard CRUD on the shared framework.
// =========================================================================

class CreateGroupDto {
  @ApiProperty() @IsString() @MaxLength(80) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) discountPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateGroupDto extends PartialType(CreateGroupDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class GroupQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

const GROUP_OPTIONS: CrudServiceOptions = {
  model: "customerGroup",
  entity: "CustomerGroup",
  searchFields: ["name", "slug", "description"],
  sortable: ["name", "createdAt"],
  filterable: ["isActive"],
  statusFields: ["isActive"],
  softDelete: true,
  hasAudit: true,
  hasVersion: true,
  slugFrom: "name",
  slugField: "slug",
  defaultSort: "name",
  include: { _count: { select: { customers: true } } },
};

@Injectable()
export class CustomerGroupsService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, GROUP_OPTIONS);
  }
  activeOptions() {
    return this.prisma.customerGroup.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, discountPercent: true },
    });
  }
}

@ApiTags("customer-groups")
@Controller({ path: "customer-groups", version: "1" })
export class CustomerGroupsController extends CrudController({
  permissions: { view: "customers:view", create: "customers:edit", edit: "customers:edit", delete: "customers:edit" },
  createDto: CreateGroupDto,
  updateDto: UpdateGroupDto,
  queryDto: GroupQueryDto,
}) {
  constructor(private readonly groups: CustomerGroupsService) {
    super(groups);
  }

  @ApiBearerAuth()
  @RequirePermissions("customers:view")
  @Get("options/active")
  active() {
    return this.groups.activeOptions();
  }
}

// =========================================================================
// CUSTOMERS — admin view over User(type=CUSTOMER): profile, orders, addresses,
// timeline, notes, groups, tags, analytics. (Dedicated service — Users are
// special: auth-bound, aggregate-heavy. RBAC customers:view / customers:edit.)
// =========================================================================

class CustomerQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() groupId?: string;
  @ApiPropertyOptional({ description: "active | blocked | inactive" })
  @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() tag?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sort?: string;
}
class SetStatusDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isBlocked?: boolean;
}
class AddNoteDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2000) note!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isInternal?: boolean;
}
class SetGroupDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() groupId?: string | null;
}
class SetTagsDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) tags!: string[];
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private buildWhere(q: CustomerQueryDto): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = { type: "CUSTOMER" };
    const and: Prisma.UserWhereInput[] = [];
    if (q.search) {
      and.push({
        OR: [
          { firstName: { contains: q.search, mode: "insensitive" } },
          { lastName: { contains: q.search, mode: "insensitive" } },
          { email: { contains: q.search, mode: "insensitive" } },
          { phone: { contains: q.search, mode: "insensitive" } },
        ],
      });
    }
    if (q.groupId) and.push({ groupId: q.groupId });
    if (q.tag) and.push({ tags: { has: q.tag } });
    if (q.status === "active") and.push({ isActive: true, isBlocked: false });
    else if (q.status === "blocked") and.push({ isBlocked: true });
    else if (q.status === "inactive") and.push({ isActive: false });
    if (and.length) where.AND = and;
    return where;
  }

  private orderBy(sort?: string): Prisma.UserOrderByWithRelationInput {
    switch (sort) {
      case "name": return { firstName: "asc" };
      case "oldest": return { createdAt: "asc" };
      case "recent-login": return { lastLoginAt: "desc" };
      default: return { createdAt: "desc" };
    }
  }

  async list(q: CustomerQueryDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const where = this.buildWhere(q);

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, orderBy: this.orderBy(q.sort), skip, take: limit,
        include: { group: { select: { id: true, name: true } }, _count: { select: { orders: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);

    const ids = users.map((u) => u.id);
    const spent = ids.length
      ? await this.prisma.order.groupBy({
          by: ["userId"],
          where: { userId: { in: ids }, deletedAt: null, status: SPENT_STATUSES },
          _sum: { grandTotal: true },
        })
      : [];
    const spentMap = new Map(spent.map((s) => [s.userId, Number(s._sum.grandTotal ?? 0)]));

    return {
      items: users.map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        phone: u.phone,
        avatarUrl: u.avatarUrl,
        group: u.group,
        tags: u.tags,
        isActive: u.isActive,
        isBlocked: u.isBlocked,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        orderCount: u._count.orders,
        totalSpent: spentMap.get(u.id) ?? 0,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 },
    };
  }

  private async loadCustomer(id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, type: "CUSTOMER" } });
    if (!user) throw new NotFoundException("Customer not found");
    return user;
  }

  async detail(id: string) {
    const user = await this.loadCustomer(id);
    const [group, addresses, orders, notes, logins, activity, agg] = await Promise.all([
      user.groupId ? this.prisma.customerGroup.findUnique({ where: { id: user.groupId }, select: { id: true, name: true, discountPercent: true } }) : null,
      this.prisma.address.findMany({ where: { userId: id }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }),
      this.prisma.order.findMany({
        where: { userId: id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, orderNumber: true, status: true, paymentStatus: true, grandTotal: true, currency: true, createdAt: true, _count: { select: { items: true } } },
      }),
      this.prisma.customerNote.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" } }),
      this.prisma.loginHistory.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      this.prisma.activityLog.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 15 }),
      this.prisma.order.aggregate({ where: { userId: id, deletedAt: null, status: SPENT_STATUSES }, _sum: { grandTotal: true }, _avg: { grandTotal: true }, _count: true }),
    ]);

    // Merge into a single reverse-chronological timeline.
    const timeline = [
      ...orders.map((o) => ({ type: "order", at: o.createdAt, title: `Order ${o.orderNumber}`, detail: `${o.status} · ${o.currency} ${Number(o.grandTotal).toFixed(2)}`, ref: o.id })),
      ...notes.map((n) => ({ type: "note", at: n.createdAt, title: n.isInternal ? "Internal note" : "Note", detail: n.note, ref: n.id })),
      ...logins.map((l) => ({ type: "login", at: l.createdAt, title: l.success ? "Signed in" : "Failed sign-in", detail: l.ip ?? "", ref: l.id })),
      ...activity.map((a) => ({ type: "activity", at: a.createdAt, title: a.action, detail: a.entity ?? "", ref: a.id })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 40);

    const { passwordHash: _ph, ...safe } = user;
    return {
      ...safe,
      name: `${user.firstName} ${user.lastName}`.trim(),
      group,
      addresses,
      orders: orders.map((o) => ({ ...o, grandTotal: Number(o.grandTotal), itemCount: o._count.items })),
      notes,
      stats: {
        orderCount: agg._count,
        totalSpent: Number(agg._sum?.grandTotal ?? 0),
        avgOrderValue: Number(agg._avg?.grandTotal ?? 0),
      },
      timeline,
    };
  }

  async analytics() {
    const start = new Date();
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const base: Prisma.UserWhereInput = { type: "CUSTOMER" };

    const [total, newThisMonth, blocked, withOrders, groups, topSpendersRaw] = await Promise.all([
      this.prisma.user.count({ where: base }),
      this.prisma.user.count({ where: { ...base, createdAt: { gte: start } } }),
      this.prisma.user.count({ where: { ...base, isBlocked: true } }),
      this.prisma.user.count({ where: { ...base, orders: { some: { deletedAt: null } } } }),
      this.prisma.customerGroup.findMany({ where: { deletedAt: null }, select: { name: true, _count: { select: { customers: true } } }, orderBy: { name: "asc" } }),
      this.prisma.order.groupBy({ by: ["userId"], where: { deletedAt: null, status: SPENT_STATUSES, userId: { not: null } }, _sum: { grandTotal: true }, orderBy: { _sum: { grandTotal: "desc" } }, take: 5 }),
    ]);

    const topIds = topSpendersRaw.map((t) => t.userId!).filter(Boolean);
    const topUsers = topIds.length ? await this.prisma.user.findMany({ where: { id: { in: topIds } }, select: { id: true, firstName: true, lastName: true, email: true } }) : [];
    const topMap = new Map(topUsers.map((u) => [u.id, u]));

    return {
      totalCustomers: total,
      newThisMonth,
      blocked,
      withOrders,
      groups: groups.map((g) => ({ name: g.name, count: g._count.customers })),
      topSpenders: topSpendersRaw.map((t) => {
        const u = topMap.get(t.userId!);
        return { id: t.userId, name: u ? `${u.firstName} ${u.lastName}`.trim() : "—", email: u?.email ?? "", spent: Number(t._sum?.grandTotal ?? 0) };
      }),
    };
  }

  async setStatus(id: string, dto: SetStatusDto, actor?: AuthUser, ip?: string) {
    const before = await this.loadCustomer(id);
    const data: Prisma.UserUpdateInput = {};
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.isBlocked !== undefined) data.isBlocked = dto.isBlocked;
    const user = await this.prisma.user.update({ where: { id }, data, select: { id: true, isActive: true, isBlocked: true } });
    await this.audit.record({ actor, action: "customer.status", entity: "User", entityId: id, before: { isActive: before.isActive, isBlocked: before.isBlocked }, after: data, ip });
    return user;
  }

  async addNote(id: string, dto: AddNoteDto, actor?: AuthUser, ip?: string) {
    await this.loadCustomer(id);
    const note = await this.prisma.customerNote.create({
      data: { userId: id, note: dto.note.trim(), isInternal: dto.isInternal ?? true, createdById: actor?.sub ?? null },
    });
    await this.audit.record({ actor, action: "customer.note", entity: "User", entityId: id, after: { isInternal: note.isInternal }, ip });
    return note;
  }

  async setGroup(id: string, dto: SetGroupDto, actor?: AuthUser, ip?: string) {
    await this.loadCustomer(id);
    if (dto.groupId) {
      const group = await this.prisma.customerGroup.findFirst({ where: { id: dto.groupId, deletedAt: null } });
      if (!group) throw new NotFoundException("Customer group not found");
    }
    const user = await this.prisma.user.update({ where: { id }, data: { groupId: dto.groupId ?? null }, include: { group: { select: { id: true, name: true } } } });
    await this.audit.record({ actor, action: "customer.group", entity: "User", entityId: id, after: { groupId: dto.groupId ?? null }, ip });
    return { id: user.id, group: user.group };
  }

  async setTags(id: string, dto: SetTagsDto, actor?: AuthUser, ip?: string) {
    await this.loadCustomer(id);
    const tags = [...new Set(dto.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 25);
    const user = await this.prisma.user.update({ where: { id }, data: { tags }, select: { id: true, tags: true } });
    await this.audit.record({ actor, action: "customer.tags", entity: "User", entityId: id, after: { tags }, ip });
    return user;
  }
}

@ApiTags("customers")
@ApiBearerAuth()
@Controller({ path: "customers", version: "1" })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermissions("customers:view")
  @Get()
  list(@Query() query: CustomerQueryDto) {
    return this.customers.list(query);
  }

  @ApiOperation({ summary: "Customer analytics (totals, new, blocked, groups, top spenders)" })
  @RequirePermissions("customers:view")
  @Get("reports/analytics")
  analytics() {
    return this.customers.analytics();
  }

  @RequirePermissions("customers:view")
  @Get(":id")
  detail(@Param("id", uuid()) id: string) {
    return this.customers.detail(id);
  }

  @RequirePermissions("customers:edit")
  @Patch(":id/status")
  setStatus(@Param("id", uuid()) id: string, @Body() dto: SetStatusDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.customers.setStatus(id, dto, u, req.ip);
  }

  @RequirePermissions("customers:edit")
  @Post(":id/notes")
  addNote(@Param("id", uuid()) id: string, @Body() dto: AddNoteDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.customers.addNote(id, dto, u, req.ip);
  }

  @RequirePermissions("customers:edit")
  @Patch(":id/group")
  setGroup(@Param("id", uuid()) id: string, @Body() dto: SetGroupDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.customers.setGroup(id, dto, u, req.ip);
  }

  @RequirePermissions("customers:edit")
  @Patch(":id/tags")
  setTags(@Param("id", uuid()) id: string, @Body() dto: SetTagsDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.customers.setTags(id, dto, u, req.ip);
  }
}

@Module({
  controllers: [CustomerGroupsController, CustomersController],
  providers: [CustomerGroupsService, CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
