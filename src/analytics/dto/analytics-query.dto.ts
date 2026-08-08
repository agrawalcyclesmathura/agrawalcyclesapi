import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

export const REVENUE_PERIODS = ["daily", "weekly", "monthly", "yearly"] as const;
export type RevenuePeriod = (typeof REVENUE_PERIODS)[number];

export class RevenueQueryDto {
  @ApiPropertyOptional({ enum: REVENUE_PERIODS, default: "monthly" })
  @IsOptional() @IsIn(REVENUE_PERIODS)
  period?: RevenuePeriod;
}

export class TopProductsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional() @IsInt() @Min(1) @Max(50)
  limit?: number;
}
