import { Module, Controller, Get, Query, Injectable } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";
import { PaginationDto, paginate } from "../common/dto/pagination.dto";
import { RequirePermissions } from "../auth/decorators";

@Injectable()
class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: PaginationDto) {
    const where = query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: "insensitive" as const } },
            { firstName: { contains: query.search, mode: "insensitive" as const } },
            { lastName: { contains: query.search, mode: "insensitive" as const } },
          ],
        }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: { id: true, email: true, firstName: true, lastName: true, type: true, isActive: true, createdAt: true },
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(items, total, query);
  }
}

@ApiTags("users")
@Controller({ path: "users", version: "1" })
class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiBearerAuth()
  @RequirePermissions("customers:view")
  @Get()
  findAll(@Query() query: PaginationDto) {
    return this.users.findAll(query);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
