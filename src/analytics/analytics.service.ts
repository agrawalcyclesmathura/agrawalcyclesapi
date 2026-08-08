import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { RevenuePeriod } from "./dto/analytics-query.dto";

/** Coerce a Prisma Decimal / bigint / string aggregate into a rounded number. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "bigint" ? Number(v) : Number(v as never);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Orders that count toward revenue: paid and not archived. */
const PAID_WHERE = { deletedAt: null, paymentStatus: "PAID" as const };

/**
 * Static, whitelisted SQL per revenue period — no user input is interpolated,
 * so `$queryRawUnsafe` is injection-safe here. `generate_series` yields a
 * continuous axis (zero-filled buckets), avoiding gaps in the chart.
 */
const REVENUE_SQL: Record<RevenuePeriod, string> = {
  daily: `
    SELECT to_char(g.bucket, 'DD Mon') AS label, COALESCE(SUM(o."grandTotal"), 0)::float8 AS value
    FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS g(bucket)
    LEFT JOIN "Order" o ON date_trunc('day', o."createdAt") = g.bucket AND o."paymentStatus" = 'PAID' AND o."deletedAt" IS NULL
    GROUP BY g.bucket ORDER BY g.bucket`,
  weekly: `
    SELECT to_char(g.bucket, 'DD Mon') AS label, COALESCE(SUM(o."grandTotal"), 0)::float8 AS value
    FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS g(bucket)
    LEFT JOIN "Order" o ON date_trunc('week', o."createdAt") = g.bucket AND o."paymentStatus" = 'PAID' AND o."deletedAt" IS NULL
    GROUP BY g.bucket ORDER BY g.bucket`,
  monthly: `
    SELECT to_char(g.bucket, 'Mon') AS label, COALESCE(SUM(o."grandTotal"), 0)::float8 AS value
    FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS g(bucket)
    LEFT JOIN "Order" o ON date_trunc('month', o."createdAt") = g.bucket AND o."paymentStatus" = 'PAID' AND o."deletedAt" IS NULL
    GROUP BY g.bucket ORDER BY g.bucket`,
  yearly: `
    SELECT to_char(g.bucket, 'YYYY') AS label, COALESCE(SUM(o."grandTotal"), 0)::float8 AS value
    FROM generate_series(date_trunc('year', now()) - interval '4 years', date_trunc('year', now()), interval '1 year') AS g(bucket)
    LEFT JOIN "Order" o ON date_trunc('year', o."createdAt") = g.bucket AND o."paymentStatus" = 'PAID' AND o."deletedAt" IS NULL
    GROUP BY g.bucket ORDER BY g.bucket`,
};

const CUSTOMER_GROWTH_SQL = `
  SELECT to_char(g.bucket, 'Mon') AS label, COUNT(u.id)::int AS value
  FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS g(bucket)
  LEFT JOIN "User" u ON date_trunc('month', u."createdAt") = g.bucket AND u."type" = 'CUSTOMER'
  GROUP BY g.bucket ORDER BY g.bucket`;

/** Inventory rollup — needs a column-to-column comparison (quantity vs reorderLevel). */
const INVENTORY_SQL = `
  SELECT
    COALESCE(SUM(i.quantity), 0)::bigint AS "totalStock",
    COUNT(*) FILTER (WHERE i.quantity > 0 AND i.quantity <= i."reorderLevel")::int AS "lowStock",
    COUNT(*) FILTER (WHERE i.quantity <= 0)::int AS "outOfStock",
    COALESCE(SUM(i.quantity * p.price), 0)::float8 AS "inventoryValue"
  FROM "InventoryItem" i
  JOIN "Product" p ON p.id = i."productId" AND p."deletedAt" IS NULL`;

export interface Series {
  labels: string[];
  values: number[];
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async series(sql: string): Promise<Series> {
    const rows = await this.prisma.$queryRawUnsafe<{ label: string; value: number }[]>(sql);
    return {
      labels: rows.map((r) => r.label),
      values: rows.map((r) => num(r.value)),
    };
  }

  async overview() {
    const [revenueAgg, paidOrders, totalOrders, totalCustomers, totalProducts, pendingOrders, cancelledOrders, recent, inv] =
      await Promise.all([
        this.prisma.order.aggregate({ _sum: { grandTotal: true }, where: PAID_WHERE }),
        this.prisma.order.count({ where: PAID_WHERE }),
        this.prisma.order.count({ where: { deletedAt: null } }),
        this.prisma.user.count({ where: { type: "CUSTOMER" } }),
        this.prisma.product.count({ where: { deletedAt: null } }),
        this.prisma.order.count({ where: { deletedAt: null, status: "PENDING" } }),
        this.prisma.order.count({ where: { deletedAt: null, status: "CANCELLED" } }),
        this.prisma.order.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            orderNumber: true, grandTotal: true, status: true, email: true,
            user: { select: { firstName: true, lastName: true } },
          },
        }),
        this.inventory(),
      ]);

    const totalRevenue = num(revenueAgg._sum.grandTotal);
    return {
      totalRevenue,
      totalOrders,
      totalCustomers,
      averageOrderValue: paidOrders ? Math.round((totalRevenue / paidOrders) * 100) / 100 : 0,
      totalProducts,
      lowStockProducts: inv.lowStockProducts,
      pendingOrders,
      // extras consumed by the dashboard (superset of the spec)
      cancelledOrders,
      outOfStockProducts: inv.outOfStockProducts,
      recentOrders: recent.map((o) => ({
        id: o.orderNumber,
        customer: `${o.user?.firstName ?? ""} ${o.user?.lastName ?? ""}`.trim() || o.email,
        total: num(o.grandTotal),
        status: o.status.charAt(0) + o.status.slice(1).toLowerCase(),
      })),
    };
  }

  revenue(period: RevenuePeriod = "monthly") {
    return this.series(REVENUE_SQL[period] ?? REVENUE_SQL.monthly);
  }

  async sales() {
    const [ordersAgg, unitsAgg] = await Promise.all([
      this.prisma.order.aggregate({ _sum: { grandTotal: true }, _count: { _all: true }, where: PAID_WHERE }),
      this.prisma.orderItem.aggregate({
        _sum: { quantity: true },
        where: { order: PAID_WHERE },
      }),
    ]);
    const ordersCount = ordersAgg._count._all;
    const revenue = num(ordersAgg._sum.grandTotal);
    return {
      ordersCount,
      revenue,
      unitsSold: num(unitsAgg._sum.quantity),
      averageOrderValue: ordersCount ? Math.round((revenue / ordersCount) * 100) / 100 : 0,
    };
  }

  async topProducts(limit = 10) {
    const grouped = await this.prisma.orderItem.groupBy({
      by: ["productId", "name"],
      where: { productId: { not: null }, order: PAID_WHERE },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: limit,
    });
    return grouped.map((g) => ({
      productId: g.productId,
      name: g.name,
      quantitySold: num(g._sum.quantity),
      revenue: num(g._sum.total),
    }));
  }

  async inventory() {
    const [row] = await this.prisma.$queryRawUnsafe<
      { totalStock: bigint; lowStock: number; outOfStock: number; inventoryValue: number }[]
    >(INVENTORY_SQL);
    return {
      totalStock: num(row?.totalStock),
      lowStockProducts: num(row?.lowStock),
      outOfStockProducts: num(row?.outOfStock),
      inventoryValue: num(row?.inventoryValue),
    };
  }

  async customers() {
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const [total, recent, repeatGroups, growth] = await Promise.all([
      this.prisma.user.count({ where: { type: "CUSTOMER" } }),
      this.prisma.user.count({ where: { type: "CUSTOMER", createdAt: { gte: monthAgo } } }),
      this.prisma.order.groupBy({
        by: ["userId"],
        where: { deletedAt: null, userId: { not: null } },
        _count: { _all: true },
        having: { userId: { _count: { gte: 2 } } },
      }),
      this.series(CUSTOMER_GROWTH_SQL),
    ]);
    return {
      totalCustomers: total,
      newCustomers: recent,
      repeatCustomers: repeatGroups.length,
      customerGrowth: growth,
    };
  }

  async coupons() {
    const [usageAgg, discountAgg, byCoupon] = await Promise.all([
      this.prisma.coupon.aggregate({ _sum: { usageCount: true }, where: { deletedAt: null } }),
      this.prisma.order.aggregate({ _sum: { discountTotal: true }, where: { deletedAt: null, couponId: { not: null } } }),
      this.prisma.order.groupBy({
        by: ["couponId"],
        where: { deletedAt: null, couponId: { not: null } },
        _sum: { discountTotal: true },
        _count: { _all: true },
        orderBy: { _count: { couponId: "desc" } },
        take: 5,
      }),
    ]);

    const ids = byCoupon.map((c) => c.couponId!).filter(Boolean);
    const codes = ids.length
      ? await this.prisma.coupon.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, usageCount: true } })
      : [];
    const codeMap = new Map(codes.map((c) => [c.id, c]));

    return {
      usageCount: num(usageAgg._sum.usageCount),
      discountGiven: num(discountAgg._sum.discountTotal),
      topCoupons: byCoupon.map((c) => ({
        code: codeMap.get(c.couponId!)?.code ?? "—",
        usageCount: num(codeMap.get(c.couponId!)?.usageCount),
        ordersUsed: c._count._all,
        discountGiven: num(c._sum.discountTotal),
      })),
    };
  }
}
