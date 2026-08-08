import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ProductsService } from "./products.service";
import { CreateProductDto, ProductQueryDto, UpdateProductDto } from "./dto";
import { Public } from "../auth/decorators";
import { CrudController } from "../common/crud";

// ---- Admin controller (full CRUD via the shared framework) ----
@ApiTags("products")
@Controller({ path: "products", version: "1" })
export class ProductsController extends CrudController({
  permissions: {
    view: "products:view",
    create: "products:create",
    edit: "products:edit",
    delete: "products:delete",
  },
  createDto: CreateProductDto,
  updateDto: UpdateProductDto,
  queryDto: ProductQueryDto,
}) {
  constructor(private readonly products: ProductsService) {
    super(products);
  }
}

// ---- Storefront controller (public, separate path) ----
@ApiTags("storefront")
@Controller({ path: "storefront/products", version: "1" })
export class StorefrontProductsController {
  constructor(private readonly products: ProductsService) {}

  @Public()
  @Get()
  list(@Query() query: Record<string, string>) {
    return this.products.storefrontList(query);
  }

  @Public()
  @Get("collection/:key")
  collection(@Param("key") key: string, @Query("limit") limit?: string) {
    return this.products.storefrontCollection(key, limit ? Number(limit) : 12);
  }

  @Public()
  @Get(":slug")
  bySlug(@Param("slug") slug: string) {
    return this.products.storefrontBySlug(slug);
  }
}
