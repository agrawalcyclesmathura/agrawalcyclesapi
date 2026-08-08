import { Module } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { ProductsController, StorefrontProductsController } from "./products.controller";

@Module({
  controllers: [ProductsController, StorefrontProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
