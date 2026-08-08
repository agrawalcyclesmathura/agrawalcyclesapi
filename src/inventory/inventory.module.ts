import { Module } from "@nestjs/common";
import {
  BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param,
  ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { Prisma } from "@prisma/client";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, RequirePermissions, type AuthUser } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

// =========================================================================
// WAREHOUSES — standard CRUD on the shared framework.
// =========================================================================

class CreateWarehouseDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiProperty() @IsString() @MaxLength(40) code!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2) country?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class WarehouseQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

const WAREHOUSE_OPTIONS: CrudServiceOptions = {
  model: "warehouse",
  entity: "Warehouse",
  searchFields: ["name", "code", "city"],
  sortable: ["name", "code", "createdAt"],
  filterable: ["isActive", "country"],
  statusFields: ["isActive"],
  softDelete: true,
  hasAudit: true,
  hasVersion: true,
  defaultSort: "name",
  include: { _count: { select: { items: true } } },
};

@Injectable()
export class WarehousesService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, WAREHOUSE_OPTIONS);
  }

  /** Active warehouses for dropdowns (transfer destinations, etc.). */
  active() {
    return this.prisma.warehouse.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    });
  }
}

@ApiTags("warehouses")
@Controller({ path: "warehouses", version: "1" })
export class WarehousesController extends CrudController({
  permissions: { view: "inventory:view", create: "inventory:edit", edit: "inventory:edit", delete: "inventory:edit" },
  createDto: CreateWarehouseDto,
  updateDto: UpdateWarehouseDto,
  queryDto: WarehouseQueryDto,
}) {
  constructor(private readonly warehouses: WarehousesService) {
    super(warehouses);
  }

  @ApiBearerAuth()
  @RequirePermissions("inventory:view")
  @Get("options/active")
  activeOptions() {
    return this.warehouses.active();
  }
}

// =========================================================================
// INVENTORY — movement-driven stock control (adjust / receive / transfer /
// bulk / history / analytics / low-out alerts). StockMovement is the ledger.
// =========================================================================

const num = (v: unknown) => (v == null ? 0 : Number(v));
const uuid = () => new ParseUUIDPipe({ version: "4" });

type ItemStatus = "in" | "low" | "out";
function statusOf(quantity: number, reserved: number, reorderLevel: number): ItemStatus {
  const available = quantity - reserved;
  if (available <= 0) return "out";
  if (available <= reorderLevel) return "low";
  return "in";
}

// ---- DTOs ---------------------------------------------------------------

class InventoryQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() warehouseId?: string;
  @ApiPropertyOptional({ enum: ["in", "low", "out"] })
  @IsOptional() @IsIn(["in", "low", "out"]) status?: ItemStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() sort?: string;
}

class AdjustDto {
  @ApiProperty({ enum: ["set", "delta"] }) @IsIn(["set", "delta"]) mode!: "set" | "delta";
  @ApiProperty() @IsInt() quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class ReceiveDto {
  @ApiProperty() @IsInt() @Min(1) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class TransferDto {
  @ApiProperty() @IsString() toWarehouseId!: string;
  @ApiProperty() @IsInt() @Min(1) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class ReorderDto {
  @ApiProperty() @IsInt() @Min(0) reorderLevel!: number;
}
class BulkAdjustItemDto {
  @ApiProperty() @IsString() id!: string;
  @ApiProperty() @IsInt() quantity!: number;
}
class BulkAdjustDto {
  @ApiProperty({ enum: ["set", "delta"] }) @IsIn(["set", "delta"]) mode!: "set" | "delta";
  @ApiProperty({ type: [BulkAdjustItemDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkAdjustItemDto) items!: BulkAdjustItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

// ---- Service ------------------------------------------------------------

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private readonly ORDER = new Map<string, Prisma.Sql>([
    ["product", Prisma.sql`p.name ASC`],
    ["-product", Prisma.sql`p.name DESC`],
    ["quantity", Prisma.sql`i.quantity ASC`],
    ["-quantity", Prisma.sql`i.quantity DESC`],
    ["updated", Prisma.sql`i."updatedAt" ASC`],
    ["-updated", Prisma.sql`i."updatedAt" DESC`],
  ]);

  private buildWhere(q: InventoryQueryDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`p."deletedAt" IS NULL`, Prisma.sql`w."deletedAt" IS NULL`];
    if (q.warehouseId) conds.push(Prisma.sql`i."warehouseId" = ${q.warehouseId}`);
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(Prisma.sql`(p.name ILIKE ${s} OR p.sku ILIKE ${s})`);
    }
    if (q.status === "out") conds.push(Prisma.sql`(i.quantity - i.reserved) <= 0`);
    else if (q.status === "low") conds.push(Prisma.sql`(i.quantity - i.reserved) > 0 AND (i.quantity - i.reserved) <= i."reorderLevel"`);
    else if (q.status === "in") conds.push(Prisma.sql`(i.quantity - i.reserved) > i."reorderLevel"`);
    return Prisma.join(conds, " AND ");
  }

  private shape(r: Record<string, unknown>) {
    const quantity = num(r.quantity);
    const reserved = num(r.reserved);
    const reorderLevel = num(r.reorderLevel);
    const price = num(r.salePrice) || num(r.price);
    return {
      id: r.id as string,
      productId: r.productId as string,
      productName: r.productName as string,
      sku: r.sku as string,
      image: (r.image as string) ?? null,
      warehouseId: r.warehouseId as string,
      warehouseName: r.warehouseName as string,
      warehouseCode: r.warehouseCode as string,
      quantity, reserved, reorderLevel,
      available: quantity - reserved,
      status: statusOf(quantity, reserved, reorderLevel),
      stockValue: Math.round(quantity * price * 100) / 100,
      unitPrice: price,
      updatedAt: r.updatedAt as Date,
    };
  }

  async list(q: InventoryQueryDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const where = this.buildWhere(q);
    const order = this.ORDER.get(q.sort ?? "product") ?? this.ORDER.get("product")!;

    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT i.id, i.quantity, i.reserved, i."reorderLevel", i."updatedAt", i."warehouseId",
             w.name AS "warehouseName", w.code AS "warehouseCode",
             p.id AS "productId", p.name AS "productName", p.sku, p.price, p."salePrice",
             (SELECT url FROM "ProductImage" pi WHERE pi."productId" = p.id ORDER BY pi.position ASC LIMIT 1) AS image
      FROM "InventoryItem" i
      JOIN "Product" p ON p.id = i."productId"
      JOIN "Warehouse" w ON w.id = i."warehouseId"
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${skip}`;
    const totalRows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM "InventoryItem" i
      JOIN "Product" p ON p.id = i."productId"
      JOIN "Warehouse" w ON w.id = i."warehouseId"
      WHERE ${where}`;
    const total = totalRows[0]?.count ?? 0;
    return {
      items: rows.map((r) => this.shape(r)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 },
    };
  }

  private async loadItem(id: string) {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true, code: true } } },
    });
    if (!item) throw new NotFoundException("Inventory item not found");
    return item;
  }

  async detail(id: string) {
    const item = await this.loadItem(id);
    const movements = await this.prisma.stockMovement.findMany({
      where: { inventoryItemId: id }, orderBy: { createdAt: "desc" }, take: 10,
    });
    return {
      ...item,
      available: item.quantity - item.reserved,
      status: statusOf(item.quantity, item.reserved, item.reorderLevel),
      movements,
    };
  }

  async history(id: string, page = 1, limit = 20) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({ where: { inventoryItemId: id }, orderBy: { createdAt: "desc" }, skip, take }),
      this.prisma.stockMovement.count({ where: { inventoryItemId: id } }),
    ]);
    return { items, meta: { total, page, limit: take, totalPages: Math.ceil(total / take) || 0 } };
  }

  /** Core ledger write: change on-hand by `delta`, recording a signed movement. */
  private async applyMovement(
    id: string, delta: number, type: "PURCHASE" | "SALE" | "RETURN" | "ADJUSTMENT" | "TRANSFER",
    note: string | undefined, actor?: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id } });
      if (!item) throw new NotFoundException("Inventory item not found");
      const balanceAfter = item.quantity + delta;
      if (balanceAfter < 0) throw new BadRequestException("Resulting quantity cannot be negative");
      const updated = await tx.inventoryItem.update({ where: { id }, data: { quantity: balanceAfter } });
      await tx.stockMovement.create({
        data: { inventoryItemId: id, type, quantity: delta, balanceAfter, note, createdById: actor?.sub ?? null },
      });
      return updated;
    });
  }

  async adjust(id: string, dto: AdjustDto, actor?: AuthUser, ip?: string) {
    const item = await this.loadItem(id);
    const delta = dto.mode === "set" ? dto.quantity - item.quantity : dto.quantity;
    if (delta === 0) throw new BadRequestException("No change in quantity");
    const updated = await this.applyMovement(id, delta, "ADJUSTMENT", dto.note ?? "Manual adjustment", actor);
    await this.audit.record({ actor, action: "inventory.adjust", entity: "InventoryItem", entityId: id, before: { quantity: item.quantity }, after: { quantity: updated.quantity }, ip });
    return updated;
  }

  async receive(id: string, dto: ReceiveDto, actor?: AuthUser, ip?: string) {
    const updated = await this.applyMovement(id, dto.quantity, "PURCHASE", dto.note ?? "Stock received", actor);
    await this.audit.record({ actor, action: "inventory.receive", entity: "InventoryItem", entityId: id, after: { received: dto.quantity, quantity: updated.quantity }, ip });
    return updated;
  }

  async updateReorder(id: string, dto: ReorderDto, actor?: AuthUser, ip?: string) {
    await this.loadItem(id);
    const updated = await this.prisma.inventoryItem.update({ where: { id }, data: { reorderLevel: dto.reorderLevel } });
    await this.audit.record({ actor, action: "inventory.reorder", entity: "InventoryItem", entityId: id, after: { reorderLevel: dto.reorderLevel }, ip });
    return updated;
  }

  async transfer(id: string, dto: TransferDto, actor?: AuthUser, ip?: string) {
    const source = await this.loadItem(id);
    if (dto.toWarehouseId === source.warehouseId) throw new BadRequestException("Source and destination warehouses are the same");
    if (dto.quantity > source.quantity) throw new BadRequestException(`Only ${source.quantity} units on hand`);
    const dest = await this.prisma.warehouse.findFirst({ where: { id: dto.toWarehouseId, deletedAt: null } });
    if (!dest) throw new NotFoundException("Destination warehouse not found");

    const result = await this.prisma.$transaction(async (tx) => {
      const srcBalance = source.quantity - dto.quantity;
      await tx.inventoryItem.update({ where: { id }, data: { quantity: srcBalance } });
      await tx.stockMovement.create({
        data: { inventoryItemId: id, type: "TRANSFER", quantity: -dto.quantity, balanceAfter: srcBalance, createdById: actor?.sub ?? null, note: dto.note ?? `Transfer to ${dest.code}` },
      });
      const destItem = await tx.inventoryItem.upsert({
        where: { productId_warehouseId: { productId: source.productId, warehouseId: dto.toWarehouseId } },
        create: { productId: source.productId, warehouseId: dto.toWarehouseId, quantity: dto.quantity },
        update: { quantity: { increment: dto.quantity } },
      });
      await tx.stockMovement.create({
        data: { inventoryItemId: destItem.id, type: "TRANSFER", quantity: dto.quantity, balanceAfter: destItem.quantity, createdById: actor?.sub ?? null, note: dto.note ?? `Transfer from ${source.warehouse.code}` },
      });
      return { sourceQty: srcBalance, destItemId: destItem.id, destQty: destItem.quantity };
    });
    await this.audit.record({ actor, action: "inventory.transfer", entity: "InventoryItem", entityId: id, after: { toWarehouseId: dto.toWarehouseId, quantity: dto.quantity, ...result }, ip });
    return result;
  }

  async bulkAdjust(dto: BulkAdjustDto, actor?: AuthUser, ip?: string) {
    let updated = 0;
    for (const it of dto.items) {
      const item = await this.prisma.inventoryItem.findUnique({ where: { id: it.id } });
      if (!item) continue;
      const delta = dto.mode === "set" ? it.quantity - item.quantity : it.quantity;
      if (delta === 0) continue;
      await this.applyMovement(it.id, delta, "ADJUSTMENT", dto.note ?? "Bulk adjustment", actor);
      updated += 1;
    }
    await this.audit.record({ actor, action: "inventory.bulkAdjust", entity: "InventoryItem", after: { count: updated, mode: dto.mode }, ip });
    return { count: updated };
  }

  async lowStock(kind: "low" | "out") {
    const { items } = await this.list({ status: kind, limit: 100, page: 1 });
    return items;
  }

  async analytics() {
    const [agg, warehouses, counts, movements] = await Promise.all([
      this.prisma.inventoryItem.aggregate({ _count: true, _sum: { quantity: true, reserved: true } }),
      this.prisma.warehouse.count({ where: { deletedAt: null } }),
      this.prisma.$queryRaw<{ low: number; out: number; value: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE (i.quantity - i.reserved) > 0 AND (i.quantity - i.reserved) <= i."reorderLevel")::int AS low,
          COUNT(*) FILTER (WHERE (i.quantity - i.reserved) <= 0)::int AS out,
          COALESCE(SUM(i.quantity * COALESCE(p."salePrice", p.price)), 0)::float AS value
        FROM "InventoryItem" i
        JOIN "Product" p ON p.id = i."productId"
        WHERE p."deletedAt" IS NULL`,
      this.prisma.stockMovement.findMany({
        orderBy: { createdAt: "desc" }, take: 8,
        include: { inventoryItem: { select: { product: { select: { name: true, sku: true } }, warehouse: { select: { code: true } } } } },
      }),
    ]);
    const c = counts[0] ?? { low: 0, out: 0, value: 0 };
    return {
      totalSkus: agg._count,
      totalUnits: agg._sum.quantity ?? 0,
      totalReserved: agg._sum.reserved ?? 0,
      warehouses,
      lowStock: c.low,
      outOfStock: c.out,
      stockValue: Math.round(c.value * 100) / 100,
      recentMovements: movements.map((m) => ({
        id: m.id, type: m.type, quantity: m.quantity, balanceAfter: m.balanceAfter, createdAt: m.createdAt,
        product: m.inventoryItem.product.name, sku: m.inventoryItem.product.sku, warehouse: m.inventoryItem.warehouse.code,
      })),
    };
  }
}

// ---- Controller ---------------------------------------------------------

@ApiTags("inventory")
@ApiBearerAuth()
@Controller({ path: "inventory", version: "1" })
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions("inventory:view")
  @Get()
  list(@Query() query: InventoryQueryDto) {
    return this.inventory.list(query);
  }

  @ApiOperation({ summary: "Stock analytics (SKUs, units, value, low/out counts)" })
  @RequirePermissions("inventory:view")
  @Get("reports/analytics")
  analytics() {
    return this.inventory.analytics();
  }

  @RequirePermissions("inventory:view")
  @Get("reports/low-stock")
  low() {
    return this.inventory.lowStock("low");
  }

  @RequirePermissions("inventory:view")
  @Get("reports/out-of-stock")
  out() {
    return this.inventory.lowStock("out");
  }

  @RequirePermissions("inventory:edit")
  @Post("bulk-adjust")
  bulkAdjust(@Body() dto: BulkAdjustDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.inventory.bulkAdjust(dto, u, req.ip);
  }

  @RequirePermissions("inventory:view")
  @Get(":id")
  detail(@Param("id", uuid()) id: string) {
    return this.inventory.detail(id);
  }

  @RequirePermissions("inventory:view")
  @Get(":id/history")
  history(@Param("id", uuid()) id: string, @Query("page") page?: string, @Query("limit") limit?: string) {
    return this.inventory.history(id, Number(page) || 1, Number(limit) || 20);
  }

  @RequirePermissions("inventory:edit")
  @Post(":id/adjust")
  adjust(@Param("id", uuid()) id: string, @Body() dto: AdjustDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.inventory.adjust(id, dto, u, req.ip);
  }

  @RequirePermissions("inventory:edit")
  @Post(":id/receive")
  receive(@Param("id", uuid()) id: string, @Body() dto: ReceiveDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.inventory.receive(id, dto, u, req.ip);
  }

  @RequirePermissions("inventory:edit")
  @Post(":id/transfer")
  transfer(@Param("id", uuid()) id: string, @Body() dto: TransferDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.inventory.transfer(id, dto, u, req.ip);
  }

  @RequirePermissions("inventory:edit")
  @Patch(":id/reorder")
  reorder(@Param("id", uuid()) id: string, @Body() dto: ReorderDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.inventory.updateReorder(id, dto, u, req.ip);
  }
}

@Module({
  controllers: [WarehousesController, InventoryController],
  providers: [WarehousesService, InventoryService],
  exports: [WarehousesService, InventoryService],
})
export class InventoryModule {}
