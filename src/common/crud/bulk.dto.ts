import { ApiProperty } from "@nestjs/swagger";
import { ArrayNotEmpty, IsArray, IsBoolean, IsString, IsUUID } from "class-validator";

export class BulkIdsDto {
  @ApiProperty({ type: [String], description: "Target record IDs" })
  @IsArray() @ArrayNotEmpty() @IsUUID("4", { each: true })
  ids!: string[];
}

export class BulkStatusDto extends BulkIdsDto {
  @ApiProperty({ description: "Boolean status column to set (must be whitelisted per module)" })
  @IsString()
  field!: string;

  @ApiProperty({ description: "New boolean value" })
  @IsBoolean()
  value!: boolean;
}
