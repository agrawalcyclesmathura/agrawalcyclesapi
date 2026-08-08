import { Module } from "@nestjs/common";
import {
  Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags,
} from "@nestjs/swagger";
import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from "class-validator";
import { ReviewStatus, type Prisma } from "@prisma/client";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, Public, RequirePermissions, type AuthUser } from "../auth/decorators";

const uuid = () => new ParseUUIDPipe({ version: "4" });
const MODERATABLE: ReviewStatus[] = ["PENDING", "APPROVED", "REJECTED", "SPAM"];

// ---- DTOs ---------------------------------------------------------------

class ReviewQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional({ enum: MODERATABLE }) @IsOptional() @IsIn(MODERATABLE) status?: ReviewStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() verified?: boolean;
  @ApiPropertyOptional({ description: "only = trash view" }) @IsOptional() @IsString() trashed?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sort?: string;
}
class SetStatusDto {
  @ApiProperty({ enum: MODERATABLE }) @IsIn(MODERATABLE) status!: ReviewStatus;
}
class ReplyDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(1000) reply!: string;
}
class SubmitReviewDto {
  @ApiProperty() @IsString() productId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) rating!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) title?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(3000) body!: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) media?: string[];
}

// ---- Service ------------------------------------------------------------

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private readonly REVIEW_INCLUDE = {
    product: { select: { name: true, slug: true, images: { take: 1, orderBy: { position: "asc" as const }, select: { url: true } } } },
    user: { select: { firstName: true, lastName: true, email: true, avatarUrl: true } },
  };

  /** Recompute a product's cached rating average + count from APPROVED reviews. */
  private async recompute(productId: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const agg = await db.review.aggregate({ where: { productId, status: "APPROVED", deletedAt: null }, _avg: { rating: true }, _count: true });
    await db.product.update({
      where: { id: productId },
      data: { ratingAvg: Math.round((agg._avg.rating ?? 0) * 100) / 100, ratingCount: agg._count },
    });
  }

  private orderBy(sort?: string): Prisma.ReviewOrderByWithRelationInput {
    switch (sort) {
      case "oldest": return { createdAt: "asc" };
      case "rating-high": return { rating: "desc" };
      case "rating-low": return { rating: "asc" };
      default: return { createdAt: "desc" };
    }
  }

  async list(q: ReviewQueryDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const where: Prisma.ReviewWhereInput = { deletedAt: q.trashed === "only" ? { not: null } : null };
    const and: Prisma.ReviewWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.productId) and.push({ productId: q.productId });
    if (q.rating) and.push({ rating: q.rating });
    if (q.verified !== undefined) and.push({ verified: q.verified });
    if (q.search) and.push({ OR: [{ title: { contains: q.search, mode: "insensitive" } }, { body: { contains: q.search, mode: "insensitive" } }] });
    if (and.length) where.AND = and;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({ where, orderBy: this.orderBy(q.sort), skip, take: limit, include: this.REVIEW_INCLUDE }),
      this.prisma.review.count({ where }),
    ]);
    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 } };
  }

  async analytics() {
    const [byStatus, approvedAgg, verified, total] = await Promise.all([
      this.prisma.review.groupBy({ by: ["status"], _count: true, where: { deletedAt: null } }),
      this.prisma.review.aggregate({ where: { status: "APPROVED", deletedAt: null }, _avg: { rating: true }, _count: true }),
      this.prisma.review.count({ where: { deletedAt: null, verified: true } }),
      this.prisma.review.count({ where: { deletedAt: null } }),
    ]);
    const status = Object.fromEntries(byStatus.map((g) => [g.status, g._count]));
    return {
      total,
      pending: status.PENDING ?? 0,
      approved: status.APPROVED ?? 0,
      rejected: status.REJECTED ?? 0,
      spam: status.SPAM ?? 0,
      verified,
      avgRating: Math.round((approvedAgg._avg.rating ?? 0) * 100) / 100,
    };
  }

  private async load(id: string) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw new NotFoundException("Review not found");
    return review;
  }

  async setStatus(id: string, status: ReviewStatus, actor?: AuthUser, ip?: string) {
    const before = await this.load(id);
    const updated = await this.prisma.review.update({ where: { id }, data: { status }, include: this.REVIEW_INCLUDE });
    // Rating cache depends on the APPROVED set — recompute if it changed.
    if (before.status === "APPROVED" || status === "APPROVED") await this.recompute(before.productId);
    await this.audit.record({ actor, action: "review.status", entity: "Review", entityId: id, before: { status: before.status }, after: { status }, ip });
    return updated;
  }

  async reply(id: string, dto: ReplyDto, actor?: AuthUser, ip?: string) {
    await this.load(id);
    const updated = await this.prisma.review.update({
      where: { id },
      data: { reply: dto.reply.trim(), repliedAt: new Date(), repliedById: actor?.sub ?? null },
      include: this.REVIEW_INCLUDE,
    });
    await this.audit.record({ actor, action: "review.reply", entity: "Review", entityId: id, ip });
    return updated;
  }

  async remove(id: string, actor?: AuthUser, ip?: string) {
    const before = await this.load(id);
    await this.prisma.review.update({ where: { id }, data: { deletedAt: new Date() } });
    if (before.status === "APPROVED") await this.recompute(before.productId);
    await this.audit.record({ actor, action: "review.delete", entity: "Review", entityId: id, ip });
    return { success: true, id };
  }

  async restore(id: string, actor?: AuthUser, ip?: string) {
    const before = await this.load(id);
    const restored = await this.prisma.review.update({ where: { id }, data: { deletedAt: null }, include: this.REVIEW_INCLUDE });
    if (before.status === "APPROVED") await this.recompute(before.productId);
    await this.audit.record({ actor, action: "review.restore", entity: "Review", entityId: id, ip });
    return restored;
  }

  // ---- Customer / storefront ----

  /** Has this user actually bought the product? (non-cancelled/refunded order containing it) */
  private async hasPurchased(userId: string, productId: string) {
    const count = await this.prisma.order.count({
      where: {
        userId, deletedAt: null,
        status: { notIn: ["CANCELLED", "REFUNDED"] },
        items: { some: { productId } },
      },
    });
    return count > 0;
  }

  async submit(userId: string, email: string, dto: SubmitReviewDto, ip?: string) {
    const product = await this.prisma.product.findFirst({ where: { id: dto.productId, deletedAt: null } });
    if (!product) throw new NotFoundException("Product not found");
    const verified = await this.hasPurchased(userId, dto.productId);

    // One review per (product, user) — resubmitting updates + resets to PENDING moderation.
    const review = await this.prisma.review.upsert({
      where: { productId_userId: { productId: dto.productId, userId } },
      create: {
        productId: dto.productId, userId, rating: dto.rating, title: dto.title, body: dto.body,
        media: dto.media ?? [], verified, status: "PENDING",
      },
      update: {
        rating: dto.rating, title: dto.title, body: dto.body, media: dto.media ?? [],
        verified, status: "PENDING", deletedAt: null,
      },
    });
    await this.audit.record({ actor: { sub: userId, email } as AuthUser, action: "review.submit", entity: "Review", entityId: review.id, after: { productId: dto.productId, rating: dto.rating, verified }, ip });
    return review;
  }

  myReviews(userId: string) {
    return this.prisma.review.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { product: { select: { name: true, slug: true, images: { take: 1, orderBy: { position: "asc" }, select: { url: true } } } } },
    });
  }

  forProduct(productId: string) {
    return this.prisma.review.findMany({
      where: { productId, status: "APPROVED", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, rating: true, title: true, body: true, media: true, verified: true, reply: true, repliedAt: true, createdAt: true,
        user: { select: { firstName: true, lastName: true, avatarUrl: true } },
      },
    });
  }
}

// ---- Controllers --------------------------------------------------------

@ApiTags("reviews")
@ApiBearerAuth()
@Controller({ path: "reviews", version: "1" })
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @RequirePermissions("reviews:view")
  @Get()
  list(@Query() query: ReviewQueryDto) {
    return this.reviews.list(query);
  }

  @ApiOperation({ summary: "Review analytics (status mix, avg rating, verified)" })
  @RequirePermissions("reviews:view")
  @Get("reports/analytics")
  analytics() {
    return this.reviews.analytics();
  }

  @RequirePermissions("reviews:moderate")
  @Patch(":id/status")
  setStatus(@Param("id", uuid()) id: string, @Body() dto: SetStatusDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.reviews.setStatus(id, dto.status, u, req.ip);
  }

  @RequirePermissions("reviews:moderate")
  @Post(":id/reply")
  reply(@Param("id", uuid()) id: string, @Body() dto: ReplyDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.reviews.reply(id, dto, u, req.ip);
  }

  @RequirePermissions("reviews:moderate")
  @Post(":id/restore")
  restore(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.reviews.restore(id, u, req.ip);
  }

  @RequirePermissions("reviews:moderate")
  @Delete(":id")
  remove(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.reviews.remove(id, u, req.ip);
  }
}

@ApiTags("account")
@ApiBearerAuth()
@Controller({ path: "account/reviews", version: "1" })
export class AccountReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post()
  submit(@Body() dto: SubmitReviewDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.reviews.submit(u.sub, u.email, dto, req.ip);
  }

  @Get()
  mine(@CurrentUser() u: AuthUser) {
    return this.reviews.myReviews(u.sub);
  }
}

@ApiTags("storefront")
@Controller({ path: "storefront/reviews", version: "1" })
export class StorefrontReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get()
  list(@Query("productId") productId: string) {
    return this.reviews.forProduct(productId);
  }
}

@Module({
  controllers: [AdminReviewsController, AccountReviewsController, StorefrontReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
