import { Module } from "@nestjs/common";
import {
  Controller, Get, Injectable,
} from "@nestjs/common";
import {
  ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, MinLength,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { Public } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

// ---- DTOs ---------------------------------------------------------------

class CreateTeamMemberDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) designation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) bio?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() photoUrl?: string;
  @ApiPropertyOptional({ type: Object, description: "{ linkedin, twitter, instagram, facebook }" })
  @IsOptional() @IsObject() socials?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}

class UpdateTeamMemberDto extends PartialType(CreateTeamMemberDto) {
  @ApiPropertyOptional({ description: "Optimistic-lock version" })
  @IsOptional() @IsInt() version?: number;
}

class TeamQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}

// ---- Service ------------------------------------------------------------

const TEAM_OPTIONS: CrudServiceOptions = {
  model: "teamMember",
  entity: "TeamMember",
  searchFields: ["name", "designation"],
  sortable: ["position", "createdAt", "name"],
  filterable: ["isVisible"],
  statusFields: ["isVisible"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  defaultSort: "position",
};

@Injectable()
export class TeamService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, TEAM_OPTIONS);
  }

  /** Visible team members for the storefront (about / careers). */
  storefront() {
    return this.prisma.teamMember.findMany({
      where: { deletedAt: null, isVisible: true },
      orderBy: { position: "asc" },
    });
  }
}

// ---- Admin controller (inherits the full CRUD surface) ------------------

@ApiTags("team")
@Controller({ path: "team", version: "1" })
export class TeamController extends CrudController({
  permissions: {
    view: "team:manage",
    create: "team:manage",
    edit: "team:manage",
    delete: "team:manage",
  },
  createDto: CreateTeamMemberDto,
  updateDto: UpdateTeamMemberDto,
  queryDto: TeamQueryDto,
}) {
  constructor(private readonly team: TeamService) {
    super(team);
  }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/team", version: "1" })
export class StorefrontTeamController {
  constructor(private readonly team: TeamService) {}

  @Public()
  @Get()
  list() {
    return this.team.storefront();
  }
}

@Module({
  controllers: [TeamController, StorefrontTeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
