import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional,
  IsString, Min, MinLength, ValidateNested,
} from "class-validator";
import { CrudQueryDto } from "../common/crud";

export enum ProductStatus {
  DRAFT = "DRAFT",
  PUBLISHED = "PUBLISHED",
  ARCHIVED = "ARCHIVED",
}

class SpecDto {
  @ApiProperty() @IsString() label!: string;
  @ApiProperty() @IsString() value!: string;
}

export class CreateProductDto {
  @ApiProperty() @IsString() @MinLength(2) name!: string;
  @ApiPropertyOptional({ description: "Auto-generated if omitted" }) @IsOptional() @IsString() sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() shortDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() categoryId?: string;

  @ApiProperty() @Type(() => Number) @IsNumber() @Min(0) mrp!: number;
  @ApiProperty() @Type(() => Number) @IsNumber() @Min(0) price!: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) salePrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() saleStartsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() saleEndsAt?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) costPrice?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) taxRate?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() weight?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() lengthCm?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() widthCm?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() heightCm?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() warranty?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() frameSize?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() wheelSize?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;

  @ApiPropertyOptional({ type: [SpecDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SpecDto)
  specifications?: SpecDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) features?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() videoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isBestSeller?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isNewArrival?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isTrending?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() metaTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() metaDesc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() canonicalUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() ogImageUrl?: string;

  @ApiPropertyOptional({ type: [String], description: "Gallery image URLs (first = thumbnail)" })
  @IsOptional() @IsArray() @IsString({ each: true }) imageUrls?: string[];
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @ApiPropertyOptional({ description: "Optimistic-lock version" })
  @IsOptional() @IsInt() version?: number;
}

export class ProductQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() categoryId?: string;
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isBestSeller?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isNewArrival?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isTrending?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() minPrice?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() maxPrice?: number;
}
