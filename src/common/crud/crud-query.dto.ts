import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Base query DTO shared by every CRUD list endpoint. Modules extend this to add
 * their own strongly-typed, validated filter fields.
 */
export class CrudQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;

  @ApiPropertyOptional({ description: "Free-text search" })
  @IsOptional() @IsString()
  search?: string;

  @ApiPropertyOptional({ description: "Comma-separated fields; prefix with '-' for desc. e.g. '-createdAt,position'" })
  @IsOptional() @IsString()
  sort?: string;

  @ApiPropertyOptional({ enum: ["with", "only"], description: "Include or show only soft-deleted rows" })
  @IsOptional() @IsIn(["with", "only"])
  trashed?: "with" | "only";
}
