import { Module } from "@nestjs/common";
import {
  ConflictException, Controller, Get, Injectable, Query,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength,
} from "class-validator";
import type { AuthUser } from "../auth/decorators";
import { Public, RequirePermissions } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

const COUPON_TYPES = ["PERCENT", "FIXED", "FREE_SHIPPING"] as const;

// ---- DTOs ---------------------------------------------------------------

class CreateCouponDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(40) code!: string;
  @ApiProperty({ enum: COUPON_TYPES }) @IsIn(COUPON_TYPES as unknown as string[]) type!: string;
  @ApiProperty({ description: "Percent (0–100) for PERCENT, amount for FIXED, ignored for FREE_SHIPPING" })
  @IsNumber() @Min(0) value!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) minPurchase?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) usageLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) perUserLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expiresAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateCouponDto extends PartialType(CreateCouponDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class CouponQueryDto extends CrudQueryDto {
  @ApiPropertyOptional({ enum: COUPON_TYPES }) @IsOptional() @IsIn(COUPON_TYPES as unknown as string[]) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// ---- Service ------------------------------------------------------------

const COUPON_OPTIONS: CrudServiceOptions = {
  model: "coupon",
  entity: "Coupon",
  searchFields: ["code", "description"],
  sortable: ["code", "createdAt", "expiresAt", "usageCount"],
  filterable: ["type", "isActive"],
  statusFields: ["isActive"],
  softDelete: true,
  hasAudit: true,
  hasVersion: true,
  defaultSort: "-createdAt",
};

@Injectable()
export class CouponsService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, COUPON_OPTIONS);
  }

  private normalizeCode(code: unknown) {
    return String(code).trim().toUpperCase();
  }

  async create(dto: Record<string, unknown>, actor?: AuthUser, ip?: string) {
    const code = this.normalizeCode(dto.code);
    const clash = await this.prisma.coupon.findUnique({ where: { code } });
    if (clash) throw new ConflictException("A coupon with this code already exists");
    return super.create({ ...dto, code }, actor, ip);
  }

  async update(id: string, dto: Record<string, unknown>, actor?: AuthUser, ip?: string) {
    let data = dto;
    if (dto.code !== undefined) {
      const code = this.normalizeCode(dto.code);
      const clash = await this.prisma.coupon.findFirst({ where: { code, id: { not: id } } });
      if (clash) throw new ConflictException("A coupon with this code already exists");
      data = { ...dto, code };
    }
    return super.update(id, data, actor, ip);
  }

  /** Active, in-window coupons for public display on the storefront. */
  storefront() {
    const now = new Date();
    return this.prisma.coupon.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { code: true, type: true, value: true, description: true, minPurchase: true, maxDiscount: true, expiresAt: true },
    });
  }

  async analytics() {
    const [total, active, usageAgg, discountAgg, top] = await Promise.all([
      this.prisma.coupon.count({ where: { deletedAt: null } }),
      this.prisma.coupon.count({ where: { deletedAt: null, isActive: true } }),
      this.prisma.coupon.aggregate({ _sum: { usageCount: true }, where: { deletedAt: null } }),
      this.prisma.order.aggregate({ _sum: { discountTotal: true }, where: { deletedAt: null, couponId: { not: null } } }),
      this.prisma.coupon.findMany({
        where: { deletedAt: null, usageCount: { gt: 0 } },
        orderBy: { usageCount: "desc" }, take: 5,
        select: { id: true, code: true, type: true, usageCount: true, usageLimit: true },
      }),
    ]);
    return {
      totalCoupons: total,
      activeCoupons: active,
      totalRedemptions: usageAgg._sum?.usageCount ?? 0,
      totalDiscountGiven: Math.round(Number(discountAgg._sum?.discountTotal ?? 0) * 100) / 100,
      topCoupons: top,
    };
  }
}

// ---- Admin controller (full CRUD surface + analytics) -------------------

@ApiTags("coupons")
@Controller({ path: "coupons", version: "1" })
export class CouponsController extends CrudController({
  permissions: { view: "coupons:view", create: "coupons:manage", edit: "coupons:manage", delete: "coupons:manage" },
  createDto: CreateCouponDto,
  updateDto: UpdateCouponDto,
  queryDto: CouponQueryDto,
}) {
  constructor(private readonly coupons: CouponsService) {
    super(coupons);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Coupon analytics (redemptions, discount given, top codes)" })
  @RequirePermissions("coupons:view")
  @Get("reports/analytics")
  analytics() {
    return this.coupons.analytics();
  }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/coupons", version: "1" })
export class StorefrontCouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Public()
  @Get()
  list() {
    return this.coupons.storefront();
  }
}

@Module({
  controllers: [CouponsController, StorefrontCouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
