import { Module } from "@nestjs/common";
import {
  Controller, Get, Injectable,
} from "@nestjs/common";
import {
  ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsBoolean, IsEmail, IsInt, IsNumber, IsOptional, IsString, MaxLength, MinLength,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { Public } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

// ---- DTOs ---------------------------------------------------------------

class CreateStoreDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @ApiPropertyOptional({ description: "Auto-generated from name when omitted." })
  @IsOptional() @IsString() @MaxLength(180) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) addressLine?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) country?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) zip?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ description: "Opening hours, e.g. \"Mon–Sun: 10am–8pm\"." })
  @IsOptional() @IsString() @MaxLength(200) hours?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() mapUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateStoreDto extends PartialType(CreateStoreDto) {
  @ApiPropertyOptional({ description: "Optimistic-lock version" })
  @IsOptional() @IsInt() version?: number;
}

class StoreQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// ---- Service ------------------------------------------------------------

const STORE_OPTIONS: CrudServiceOptions = {
  model: "store",
  entity: "Store",
  searchFields: ["name", "city", "state", "addressLine"],
  sortable: ["position", "createdAt", "name"],
  filterable: ["city", "isActive"],
  statusFields: ["isActive"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  slugFrom: "name",
  slugField: "slug",
  defaultSort: "position",
};

@Injectable()
export class StoresService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, STORE_OPTIONS);
  }

  /** Active stores for the storefront (locator + showroom). */
  storefront() {
    return this.prisma.store.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { position: "asc" },
    });
  }
}

// ---- Admin controller (inherits the full CRUD surface) ------------------

@ApiTags("stores")
@Controller({ path: "stores", version: "1" })
export class StoresController extends CrudController({
  permissions: {
    view: "stores:manage",
    create: "stores:manage",
    edit: "stores:manage",
    delete: "stores:manage",
  },
  createDto: CreateStoreDto,
  updateDto: UpdateStoreDto,
  queryDto: StoreQueryDto,
}) {
  constructor(private readonly stores: StoresService) {
    super(stores);
  }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/stores", version: "1" })
export class StorefrontStoresController {
  constructor(private readonly stores: StoresService) {}

  @Public()
  @Get()
  list() {
    return this.stores.storefront();
  }
}

@Module({
  controllers: [StoresController, StorefrontStoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
