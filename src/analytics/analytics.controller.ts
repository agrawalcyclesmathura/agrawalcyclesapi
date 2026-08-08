import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { RequirePermissions } from "../auth/decorators";
import { AnalyticsService } from "./analytics.service";
import { RevenueQueryDto, TopProductsQueryDto } from "./dto/analytics-query.dto";

@ApiTags("analytics")
@ApiBearerAuth()
@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @ApiOperation({ summary: "Headline KPIs for the dashboard" })
  @RequirePermissions("analytics:view")
  @Get("overview")
  overview() {
    return this.analytics.overview();
  }

  @ApiOperation({ summary: "Revenue time series (daily | weekly | monthly | yearly)" })
  @RequirePermissions("analytics:view")
  @Get("revenue")
  revenue(@Query() q: RevenueQueryDto) {
    return this.analytics.revenue(q.period ?? "monthly");
  }

  @ApiOperation({ summary: "Sales totals (orders, revenue, units, AOV)" })
  @RequirePermissions("analytics:view")
  @Get("sales")
  sales() {
    return this.analytics.sales();
  }

  @ApiOperation({ summary: "Best-selling products by units and revenue" })
  @RequirePermissions("analytics:view")
  @Get("top-products")
  topProducts(@Query() q: TopProductsQueryDto) {
    return this.analytics.topProducts(q.limit ?? 10);
  }

  @ApiOperation({ summary: "Inventory rollup (stock, low/out, value)" })
  @RequirePermissions("analytics:view")
  @Get("inventory")
  inventory() {
    return this.analytics.inventory();
  }

  @ApiOperation({ summary: "Customer totals and growth" })
  @RequirePermissions("analytics:view")
  @Get("customers")
  customers() {
    return this.analytics.customers();
  }

  @ApiOperation({ summary: "Coupon usage and discounts" })
  @RequirePermissions("analytics:view")
  @Get("coupons")
  coupons() {
    return this.analytics.coupons();
  }
}
