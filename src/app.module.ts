import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { CommonModule } from "./common/common.module";
import { AuthModule } from "./auth/auth.module";
import { FirebaseModule } from "./firebase/firebase.module";
import { UsersModule } from "./users/users.module";
import { ProductsModule } from "./products/products.module";
import { CategoriesModule } from "./categories/categories.module";
import { SettingsModule } from "./settings/settings.module";
import { MediaModule } from "./media/media.module";
import { BannersModule } from "./banners/banners.module";
import { BrandsModule } from "./brands/brands.module";
import { AccountModule } from "./account/account.module";
import { CartModule } from "./cart/cart.module";
import { OrdersModule } from "./orders/orders.module";
import { PaymentsModule } from "./payments/payments.module";
import { InventoryModule } from "./inventory/inventory.module";
import { CustomersModule } from "./customers/customers.module";
import { CouponsModule } from "./coupons/coupons.module";
import { ReviewsModule } from "./reviews/reviews.module";
import { ContentModule } from "./content/content.module";
import { BlogModule } from "./blog/blog.module";
import { RbacModule } from "./rbac/rbac.module";
import { MenusModule } from "./menus/menus.module";
import { HomeModule } from "./home/home.module";
import { RedirectsModule } from "./redirects/redirects.module";
import { PagesModule } from "./pages/pages.module";
import { StoresModule } from "./stores/stores.module";
import { TeamModule } from "./team/team.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    RedisModule,
    CommonModule,
    FirebaseModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    CategoriesModule,
    SettingsModule,
    MediaModule,
    BannersModule,
    BrandsModule,
    AccountModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    InventoryModule,
    CustomersModule,
    CouponsModule,
    ReviewsModule,
    ContentModule,
    BlogModule,
    RbacModule,
    MenusModule,
    HomeModule,
    RedirectsModule,
    PagesModule,
    StoresModule,
    TeamModule,
    AnalyticsModule,
    NotificationsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
