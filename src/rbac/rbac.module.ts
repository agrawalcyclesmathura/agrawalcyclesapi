import { Module } from "@nestjs/common";
import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param,
  ParseUUIDPipe, Patch, Post, Put, Query, Req,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags,
} from "@nestjs/swagger";
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, RequirePermissions, type AuthUser } from "../auth/decorators";
import { slugify } from "../common/crud";

const uuid = () => new ParseUUIDPipe({ version: "4" });
const STAFF_WHERE = { roles: { some: { role: { slug: { not: "customer" } } } } };

// ---- DTOs ---------------------------------------------------------------

class CreateRoleDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
}
class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
}
class SetPermissionsDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) keys!: string[];
}
class InviteStaffDto {
  @ApiProperty() @IsString() email!: string;
  @ApiProperty() @IsString() @MinLength(1) firstName!: string;
  @ApiProperty() @IsString() @MinLength(1) lastName!: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) roleIds!: string[];
}
class UpdateStaffDto {
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) roleIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// ---- Roles --------------------------------------------------------------

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { permissions: true, users: true } } },
    });
    return roles.map((r) => ({
      id: r.id, name: r.name, slug: r.slug, description: r.description, isSystem: r.isSystem,
      permissionCount: r._count.permissions, userCount: r._count.users,
    }));
  }

  async detail(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id }, include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException("Role not found");
    return { id: role.id, name: role.name, slug: role.slug, description: role.description, isSystem: role.isSystem,
      permissionKeys: role.permissions.map((p) => p.permission.key) };
  }

  private async uniqueSlug(base: string) {
    let slug = base || "role"; let n = 1;
    while (await this.prisma.role.findUnique({ where: { slug } })) { n += 1; slug = `${base}-${n}`; }
    return slug;
  }

  async create(dto: CreateRoleDto, actor?: AuthUser, ip?: string) {
    const slug = await this.uniqueSlug(slugify(dto.name));
    const role = await this.prisma.role.create({ data: { name: dto.name, slug, description: dto.description, isSystem: false } });
    await this.audit.record({ actor, action: "role.create", entity: "Role", entityId: role.id, after: { name: role.name }, ip });
    return role;
  }

  async update(id: string, dto: UpdateRoleDto, actor?: AuthUser, ip?: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException("Role not found");
    const updated = await this.prisma.role.update({ where: { id }, data: { name: dto.name ?? role.name, description: dto.description ?? role.description } });
    await this.audit.record({ actor, action: "role.update", entity: "Role", entityId: id, after: dto, ip });
    return updated;
  }

  async remove(id: string, actor?: AuthUser, ip?: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException("Role not found");
    if (role.isSystem) throw new BadRequestException("System roles cannot be deleted");
    if (role._count.users > 0) throw new BadRequestException("Reassign the users on this role before deleting it");
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record({ actor, action: "role.delete", entity: "Role", entityId: id, before: { name: role.name }, ip });
    return { success: true, id };
  }

  /** Replace the role's permission set (the matrix save). */
  async setPermissions(id: string, keys: string[], actor?: AuthUser, ip?: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException("Role not found");
    const perms = await this.prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: id, permissionId: p.id })), skipDuplicates: true }),
    ]);
    await this.audit.record({ actor, action: "role.permissions", entity: "Role", entityId: id, after: { count: perms.length }, ip });
    return { id, permissionKeys: keys };
  }
}

// ---- Permissions --------------------------------------------------------

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}
  async grouped() {
    const perms = await this.prisma.permission.findMany({ orderBy: [{ resource: "asc" }, { action: "asc" }] });
    const groups: Record<string, { key: string; action: string; description: string | null }[]> = {};
    for (const p of perms) {
      (groups[p.resource] ??= []).push({ key: p.key, action: p.action, description: p.description });
    }
    return { groups, all: perms.map((p) => p.key) };
  }
}

// ---- Staff (admin users) ------------------------------------------------

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(q: { page?: number; limit?: number; search?: string; status?: string }) {
    const page = q.page ?? 1; const limit = Math.min(q.limit ?? 20, 100); const skip = (page - 1) * limit;
    const and: Record<string, unknown>[] = [STAFF_WHERE];
    if (q.search) and.push({ OR: [
      { firstName: { contains: q.search, mode: "insensitive" } },
      { lastName: { contains: q.search, mode: "insensitive" } },
      { email: { contains: q.search, mode: "insensitive" } },
    ] });
    if (q.status === "active") and.push({ isActive: true });
    else if (q.status === "inactive") and.push({ isActive: false });
    const where = { AND: and };
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, orderBy: { createdAt: "desc" }, skip, take: limit,
        include: { roles: { include: { role: { select: { id: true, name: true, slug: true } } } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: users.map((u) => ({
        id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email,
        isActive: u.isActive, twoFactorEnabled: u.twoFactorEnabled, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
        roles: u.roles.map((r) => r.role),
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 },
    };
  }

  async detail(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, ...STAFF_WHERE },
      include: { roles: { include: { role: { select: { id: true, name: true, slug: true } } } } },
    });
    if (!user) throw new NotFoundException("Staff user not found");
    const now = new Date();
    const [sessions, loginHistory] = await Promise.all([
      this.prisma.refreshToken.findMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" }, select: { id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true },
      }),
      this.prisma.loginHistory.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 15 }),
    ]);
    return {
      id: user.id, name: `${user.firstName} ${user.lastName}`.trim(), email: user.email, phone: user.phone,
      isActive: user.isActive, twoFactorEnabled: user.twoFactorEnabled, mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
      roles: user.roles.map((r) => r.role), sessions, loginHistory,
    };
  }

  async invite(dto: InviteStaffDto, actor?: AuthUser, ip?: string) {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new BadRequestException("Email already registered");
    const roles = await this.prisma.role.findMany({ where: { id: { in: dto.roleIds }, slug: { not: "customer" } }, select: { id: true } });
    if (roles.length === 0) throw new BadRequestException("Assign at least one staff role");
    const tempPassword = randomBytes(9).toString("base64url"); // ~12 chars
    const passwordHash = await argon2.hash(tempPassword);
    const user = await this.prisma.user.create({
      data: {
        email, firstName: dto.firstName, lastName: dto.lastName, passwordHash,
        // A super_admin inviting staff is itself an approval; the invitee signs
        // in via Firebase with this email (STAFF password login is blocked).
        type: "STAFF", isActive: true, mustChangePassword: true, adminStatus: "APPROVED",
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    await this.audit.record({ actor, action: "staff.invite", entity: "User", entityId: user.id, after: { email, roleIds: dto.roleIds }, ip });
    return { user, tempPassword };
  }

  async update(id: string, dto: UpdateStaffDto, actor?: AuthUser, ip?: string) {
    const user = await this.prisma.user.findFirst({ where: { id, ...STAFF_WHERE } });
    if (!user) throw new NotFoundException("Staff user not found");
    if (dto.isActive === false && actor?.sub === id) throw new BadRequestException("You cannot deactivate your own account");

    if (dto.roleIds) {
      const roles = await this.prisma.role.findMany({ where: { id: { in: dto.roleIds }, slug: { not: "customer" } }, select: { id: true } });
      if (roles.length === 0) throw new BadRequestException("A staff user must keep at least one role");
      await this.prisma.$transaction([
        this.prisma.userRole.deleteMany({ where: { userId: id } }),
        this.prisma.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })), skipDuplicates: true }),
      ]);
    }
    if (dto.isActive !== undefined) {
      await this.prisma.user.update({ where: { id }, data: { isActive: dto.isActive } });
      if (!dto.isActive) await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.record({ actor, action: "staff.update", entity: "User", entityId: id, after: dto, ip });
    return this.detail(id);
  }

  async revokeSession(id: string, tokenId: string, actor?: AuthUser, ip?: string) {
    const token = await this.prisma.refreshToken.findFirst({ where: { id: tokenId, userId: id } });
    if (!token) throw new NotFoundException("Session not found");
    await this.prisma.refreshToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } });
    await this.audit.record({ actor, action: "staff.revokeSession", entity: "User", entityId: id, after: { tokenId }, ip });
    return { success: true };
  }

  async revokeAllSessions(id: string, actor?: AuthUser, ip?: string) {
    const res = await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ actor, action: "staff.revokeAllSessions", entity: "User", entityId: id, after: { count: res.count }, ip });
    return { success: true, count: res.count };
  }
}

// ---- Controllers --------------------------------------------------------

@ApiTags("roles")
@ApiBearerAuth()
@Controller({ path: "roles", version: "1" })
export class RolesController {
  constructor(private readonly roles: RolesService) {}
  @RequirePermissions("roles:manage") @Get() list() { return this.roles.list(); }
  @RequirePermissions("roles:manage") @Get(":id") detail(@Param("id", uuid()) id: string) { return this.roles.detail(id); }
  @RequirePermissions("roles:manage") @Post() create(@Body() dto: CreateRoleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.roles.create(dto, u, r.ip); }
  @RequirePermissions("roles:manage") @Patch(":id") update(@Param("id", uuid()) id: string, @Body() dto: UpdateRoleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.roles.update(id, dto, u, r.ip); }
  @RequirePermissions("roles:manage") @Delete(":id") remove(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.roles.remove(id, u, r.ip); }
  @RequirePermissions("roles:manage") @Put(":id/permissions") setPerms(@Param("id", uuid()) id: string, @Body() dto: SetPermissionsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.roles.setPermissions(id, dto.keys, u, r.ip); }
}

@ApiTags("permissions")
@ApiBearerAuth()
@Controller({ path: "permissions", version: "1" })
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}
  @RequirePermissions("roles:manage") @Get() list() { return this.permissions.grouped(); }
}

@ApiTags("staff")
@ApiBearerAuth()
@Controller({ path: "staff", version: "1" })
export class StaffController {
  constructor(private readonly staff: StaffService) {}
  @ApiOperation({ summary: "List admin/staff users" })
  @RequirePermissions("users:manage") @Get()
  list(@Query("page") page?: string, @Query("limit") limit?: string, @Query("search") search?: string, @Query("status") status?: string) {
    return this.staff.list({ page: Number(page) || 1, limit: Number(limit) || 20, search, status });
  }
  @RequirePermissions("users:manage") @Get(":id") detail(@Param("id", uuid()) id: string) { return this.staff.detail(id); }
  @RequirePermissions("users:manage") @Post("invite") invite(@Body() dto: InviteStaffDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.staff.invite(dto, u, r.ip); }
  @RequirePermissions("users:manage") @Patch(":id") update(@Param("id", uuid()) id: string, @Body() dto: UpdateStaffDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.staff.update(id, dto, u, r.ip); }
  @RequirePermissions("users:manage") @Delete(":id/sessions/:tokenId") revoke(@Param("id", uuid()) id: string, @Param("tokenId", uuid()) tokenId: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.staff.revokeSession(id, tokenId, u, r.ip); }
  @RequirePermissions("users:manage") @Delete(":id/sessions") revokeAll(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.staff.revokeAllSessions(id, u, r.ip); }
}

@Module({
  controllers: [RolesController, PermissionsController, StaffController],
  providers: [RolesService, PermissionsService, StaffService],
})
export class RbacModule {}
