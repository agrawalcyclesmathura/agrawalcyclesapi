import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { BaseCrudService, type CrudServiceOptions } from "../common/crud";
import type { AuthUser } from "../auth/decorators";

const PRODUCT_INCLUDE = {
  images: { orderBy: { position: "asc" } },
  brand: { select: { id: true, name: true, slug: true } },
  category: { select: { id: true, name: true, slug: true } },
  inventory: { select: { quantity: true, reserved: true } },
  _count: { select: { variants: true, reviews: true } },
} as const;

const PRODUCT_OPTIONS: CrudServiceOptions = {
  model: "product",
  entity: "Product",
  searchFields: ["name", "sku", "description", "shortDescription"],
  sortable: ["position", "price", "name", "createdAt", "updatedAt", "ratingAvg"],
  filterable: ["status", "brandId", "categoryId", "isFeatured", "isBestSeller", "isNewArrival", "isTrending"],
  statusFields: ["isFeatured", "isBestSeller", "isNewArrival", "isTrending"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  slugFrom: "name",
  defaultSort: "-createdAt",
  include: PRODUCT_INCLUDE as unknown as Record<string, unknown>,
};

interface StoreQuery {
  page?: number; limit?: number; search?: string; sort?: string;
  category?: string; brand?: string; minPrice?: number; maxPrice?: number;
  featured?: string; bestSeller?: string; newArrival?: string; trending?: string; onSale?: string;
}

@Injectable()
export class ProductsService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, PRODUCT_OPTIONS);
  }

  /** Extend the generic where-builder with a price range (admin list). */
  protected buildWhere(query: Record<string, unknown>): Record<string, unknown> {
    const where = super.buildWhere(query);
    const min = query.minPrice as number | undefined;
    const max = query.maxPrice as number | undefined;
    if (min != null || max != null) {
      const and = (where.AND as unknown[]) ?? [];
      const price: Record<string, number> = {};
      if (min != null) price.gte = Number(min);
      if (max != null) price.lte = Number(max);
      and.push({ price });
      where.AND = and;
    }
    return where;
  }

  private generateSku(name?: string): string {
    const base = (name ?? "PRD").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6) || "PRD";
    return `AC-${base}-${Math.floor(Math.random() * 90000 + 10000)}`;
  }

  async create(dto: Record<string, unknown>, actor?: AuthUser, ip?: string) {
    const { imageUrls, ...rest } = dto as { imageUrls?: string[] } & Record<string, unknown>;
    if (!rest.sku) rest.sku = this.generateSku(rest.name as string);
    if (imageUrls?.length) {
      rest.images = { create: imageUrls.map((url, i) => ({ url, position: i })) };
    }
    return super.create(rest, actor, ip);
  }

  async update(id: string, dto: Record<string, unknown>, actor?: AuthUser, ip?: string) {
    const { imageUrls, ...rest } = dto as { imageUrls?: string[] } & Record<string, unknown>;
    if (imageUrls) {
      rest.images = { deleteMany: {}, create: imageUrls.map((url, i) => ({ url, position: i })) };
    }
    return super.update(id, rest, actor, ip);
  }

  // -------------------- Storefront --------------------

  private storefrontWhere(q: StoreQuery): Record<string, unknown> {
    const where: Record<string, unknown> = { status: "PUBLISHED", deletedAt: null };
    const and: unknown[] = [];
    if (q.search) {
      and.push({
        OR: [
          { name: { contains: q.search, mode: "insensitive" } },
          { shortDescription: { contains: q.search, mode: "insensitive" } },
          { description: { contains: q.search, mode: "insensitive" } },
        ],
      });
    }
    if (q.category) where.category = { slug: q.category };
    if (q.brand) where.brand = { slug: q.brand };
    if (q.minPrice != null || q.maxPrice != null) {
      const price: Record<string, number> = {};
      if (q.minPrice != null) price.gte = Number(q.minPrice);
      if (q.maxPrice != null) price.lte = Number(q.maxPrice);
      and.push({ price });
    }
    if (q.featured === "true") where.isFeatured = true;
    if (q.bestSeller === "true") where.isBestSeller = true;
    if (q.newArrival === "true") where.isNewArrival = true;
    if (q.trending === "true") where.isTrending = true;
    if (q.onSale === "true") and.push({ salePrice: { not: null } });
    if (and.length) where.AND = and;
    return where;
  }

  private storeSort(sort?: string) {
    switch (sort) {
      case "price": return { price: "asc" as const };
      case "-price": return { price: "desc" as const };
      case "rating": return { ratingAvg: "desc" as const };
      case "newest": return { createdAt: "desc" as const };
      case "name": return { name: "asc" as const };
      default: return { position: "asc" as const };
    }
  }

  async storefrontList(q: StoreQuery) {
    const where = this.storefrontWhere(q);
    const limit = Math.min(Number(q.limit ?? 24), 60);
    const page = Number(q.page ?? 1);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where, include: PRODUCT_INCLUDE, orderBy: this.storeSort(q.sort),
        skip: (page - 1) * limit, take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 } };
  }

  storefrontBySlug(slug: string) {
    return this.prisma.product.findFirst({
      where: { slug, status: "PUBLISHED", deletedAt: null },
      include: {
        ...PRODUCT_INCLUDE,
        variants: true,
        tags: { include: { tag: true } },
        reviews: { where: { status: "APPROVED" }, take: 10, orderBy: { createdAt: "desc" } },
        relatedFrom: { include: { target: { include: PRODUCT_INCLUDE } } },
      },
    });
  }

  storefrontCollection(key: string, limit = 12) {
    const flags: Record<string, Record<string, unknown>> = {
      featured: { isFeatured: true },
      "best-sellers": { isBestSeller: true },
      "new-arrivals": { isNewArrival: true },
      trending: { isTrending: true },
      sale: { salePrice: { not: null } },
    };
    return this.prisma.product.findMany({
      where: { status: "PUBLISHED", deletedAt: null, ...(flags[key] ?? {}) },
      include: PRODUCT_INCLUDE,
      orderBy: { position: "asc" },
      take: Math.min(Number(limit), 40),
    });
  }
}
