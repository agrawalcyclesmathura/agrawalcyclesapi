import { Module } from "@nestjs/common";
import {
  Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, Public, RequirePermissions, type AuthUser } from "../auth/decorators";

const uuid = () => new ParseUUIDPipe({ version: "4" });
const LOCATIONS = ["header", "footer", "topbar", "mega"] as const;

// ---- DTOs ---------------------------------------------------------------

class CreateItemDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) label!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) badge?: string;
  @ApiPropertyOptional({ enum: ["_self", "_blank"] }) @IsOptional() @IsIn(["_self", "_blank"]) target?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}
class UpdateItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) badge?: string;
  @ApiPropertyOptional({ enum: ["_self", "_blank"] }) @IsOptional() @IsIn(["_self", "_blank"]) target?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}
class ReorderDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) ids!: string[];
}

interface MenuNode {
  id: string; label: string; url: string; icon: string | null; badge: string | null;
  target: string; position: number; isVisible: boolean; children: MenuNode[];
}

// ---- Service ------------------------------------------------------------

@Injectable()
export class MenusService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async menuId(location: string) {
    const menu = await this.prisma.menu.upsert({
      where: { location },
      create: { location, name: location },
      update: {},
    });
    return menu.id;
  }

  private tree(items: { id: string; parentId: string | null; label: string; url: string; icon: string | null; badge: string | null; target: string; position: number; isVisible: boolean }[], visibleOnly: boolean): MenuNode[] {
    const map = new Map<string, MenuNode>();
    for (const i of items) map.set(i.id, { id: i.id, label: i.label, url: i.url, icon: i.icon, badge: i.badge, target: i.target, position: i.position, isVisible: i.isVisible, children: [] });
    const roots: MenuNode[] = [];
    for (const i of items) {
      if (visibleOnly && !i.isVisible) continue;
      const node = map.get(i.id)!;
      if (i.parentId && map.has(i.parentId)) map.get(i.parentId)!.children.push(node);
      else roots.push(node);
    }
    const sort = (ns: MenuNode[]) => { ns.sort((a, b) => a.position - b.position); ns.forEach((n) => sort(n.children)); };
    sort(roots);
    return roots;
  }

  async locations() {
    const menus = await this.prisma.menu.findMany({ include: { _count: { select: { items: true } } } });
    const byLoc = new Map(menus.map((m) => [m.location, m._count.items]));
    return LOCATIONS.map((location) => ({ location, itemCount: byLoc.get(location) ?? 0 }));
  }

  async get(location: string, visibleOnly = false) {
    const items = await this.prisma.menuItem.findMany({
      where: { menu: { location } },
      orderBy: { position: "asc" },
      select: { id: true, parentId: true, label: true, url: true, icon: true, badge: true, target: true, position: true, isVisible: true },
    });
    return this.tree(items, visibleOnly);
  }

  async addItem(location: string, dto: CreateItemDto, actor?: AuthUser, ip?: string) {
    const menuId = await this.menuId(location);
    if (dto.parentId) {
      const parent = await this.prisma.menuItem.findFirst({ where: { id: dto.parentId, menuId } });
      if (!parent) throw new NotFoundException("Parent item not found in this menu");
    }
    const max = await this.prisma.menuItem.aggregate({ where: { menuId, parentId: dto.parentId ?? null }, _max: { position: true } });
    const item = await this.prisma.menuItem.create({
      data: {
        menuId, parentId: dto.parentId ?? null, label: dto.label, url: dto.url ?? "#",
        icon: dto.icon, badge: dto.badge, target: dto.target ?? "_self", isVisible: dto.isVisible ?? true,
        position: (max._max.position ?? -1) + 1,
      },
    });
    await this.audit.record({ actor, action: "menu.itemCreate", entity: "MenuItem", entityId: item.id, after: { location, label: dto.label }, ip });
    return item;
  }

  async updateItem(id: string, dto: UpdateItemDto, actor?: AuthUser, ip?: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException("Menu item not found");
    const updated = await this.prisma.menuItem.update({ where: { id }, data: dto });
    await this.audit.record({ actor, action: "menu.itemUpdate", entity: "MenuItem", entityId: id, after: dto, ip });
    return updated;
  }

  async removeItem(id: string, actor?: AuthUser, ip?: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException("Menu item not found");
    await this.prisma.menuItem.delete({ where: { id } }); // cascades to children
    await this.audit.record({ actor, action: "menu.itemDelete", entity: "MenuItem", entityId: id, ip });
    return { success: true, id };
  }

  /** Persist a new order for a flat list of sibling ids. */
  async reorder(ids: string[], actor?: AuthUser, ip?: string) {
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.menuItem.update({ where: { id }, data: { position: i } })));
    await this.audit.record({ actor, action: "menu.reorder", entity: "MenuItem", after: { count: ids.length }, ip });
    return { success: true };
  }
}

// ---- Admin controller ---------------------------------------------------

@ApiTags("menus")
@ApiBearerAuth()
@Controller({ path: "menus", version: "1" })
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  @RequirePermissions("menus:manage") @Get() locations() { return this.menus.locations(); }
  @RequirePermissions("menus:manage") @Get(":location") get(@Param("location") location: string) { return this.menus.get(location); }
  @RequirePermissions("menus:manage") @Post(":location/items")
  add(@Param("location") location: string, @Body() dto: CreateItemDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.menus.addItem(location, dto, u, r.ip); }
  @RequirePermissions("menus:manage") @Post(":location/reorder")
  reorder(@Body() dto: ReorderDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.menus.reorder(dto.ids, u, r.ip); }
  @RequirePermissions("menus:manage") @Patch("items/:id")
  update(@Param("id", uuid()) id: string, @Body() dto: UpdateItemDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.menus.updateItem(id, dto, u, r.ip); }
  @RequirePermissions("menus:manage") @Delete("items/:id")
  remove(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.menus.removeItem(id, u, r.ip); }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/menus", version: "1" })
export class StorefrontMenusController {
  constructor(private readonly menus: MenusService) {}
  @Public() @Get(":location") get(@Param("location") location: string) { return this.menus.get(location, true); }
}

@Module({
  controllers: [MenusController, StorefrontMenusController],
  providers: [MenusService],
  exports: [MenusService],
})
export class MenusModule {}
