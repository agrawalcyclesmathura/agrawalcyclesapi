import {
  Body, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, type Type,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import type { Request } from "express";
import {
  CurrentUser, RequirePermissions, Roles, type AuthUser,
} from "../../auth/decorators";
import { BaseCrudService } from "./base-crud.service";
import { AbstractValidationPipe } from "./abstract-validation.pipe";
import { BulkIdsDto, BulkStatusDto } from "./bulk.dto";

export interface CrudControllerOptions {
  permissions: {
    view: string;
    create: string;
    edit: string;
    delete: string;
    /** Permission for permanent delete; defaults to "system:manage" (Super Admin). */
    hardDelete?: string;
  };
  createDto: Type<unknown>;
  updateDto: Type<unknown>;
  queryDto: Type<unknown>;
}

const VALIDATION = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};

/**
 * Produces a fully-decorated controller class implementing the standard CRUD
 * surface. Concrete modules extend it, set their own @Controller path/@ApiTags,
 * inject their service and pass it to super(). Every route is permission-guarded
 * and validated against the module's DTOs.
 *
 *   GET    /            list (pagination/search/sort/filter/trash)
 *   GET    /:id         read one
 *   POST   /            create
 *   PATCH  /:id         update (optimistic locking when supported)
 *   DELETE /:id         soft delete
 *   POST   /:id/restore restore
 *   POST   /bulk-delete
 *   POST   /bulk-restore
 *   POST   /bulk-status
 *   DELETE /:id/permanent  hard delete (Super Admin only)
 */
export function CrudController(opts: CrudControllerOptions) {
  const queryPipe = new AbstractValidationPipe(VALIDATION, { query: opts.queryDto });
  const createPipe = new AbstractValidationPipe(VALIDATION, { body: opts.createDto });
  const updatePipe = new AbstractValidationPipe(VALIDATION, { body: opts.updateDto });
  const uuid = new ParseUUIDPipe({ version: "4" });

  class BaseCrudController {
    constructor(public readonly service: BaseCrudService) {}

    @ApiBearerAuth()
    @ApiOperation({ summary: "List (pagination, search, sort, filter, trash)" })
    @RequirePermissions(opts.permissions.view)
    @Get()
    findAll(@Query(queryPipe) query: Record<string, unknown>) {
      return this.service.findAll(query as never);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.delete)
    @Post("bulk-delete")
    bulkDelete(@Body() dto: BulkIdsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.bulkDelete(dto.ids, user, req.ip);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.delete)
    @Post("bulk-restore")
    bulkRestore(@Body() dto: BulkIdsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.bulkRestore(dto.ids, user, req.ip);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.edit)
    @Post("bulk-status")
    bulkStatus(@Body() dto: BulkStatusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.bulkStatus(dto.ids, dto.field, dto.value, user, req.ip);
    }

    @ApiBearerAuth()
    @ApiOperation({ summary: "Persist manual order (ids in desired order)" })
    @RequirePermissions(opts.permissions.edit)
    @Post("reorder")
    reorder(@Body() dto: BulkIdsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.reorder(dto.ids, user, req.ip);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.view)
    @Get(":id")
    findOne(@Param("id", uuid) id: string) {
      return this.service.findOne(id);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.create)
    @Post()
    create(
      @Body(createPipe) dto: Record<string, unknown>,
      @CurrentUser() user: AuthUser,
      @Req() req: Request,
    ) {
      return this.service.create(dto, user, req.ip);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.edit)
    @Patch(":id")
    update(
      @Param("id", uuid) id: string,
      @Body(updatePipe) dto: Record<string, unknown>,
      @CurrentUser() user: AuthUser,
      @Req() req: Request,
    ) {
      return this.service.update(id, dto, user, req.ip);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.delete)
    @Delete(":id")
    remove(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.remove(id, user, req.ip);
    }

    @ApiBearerAuth()
    @RequirePermissions(opts.permissions.delete)
    @Post(":id/restore")
    restore(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.restore(id, user, req.ip);
    }

    @ApiBearerAuth()
    @ApiOperation({ summary: "Permanently delete (Super Admin only)" })
    @Roles("super_admin", "owner")
    @RequirePermissions(opts.permissions.hardDelete ?? "system:manage")
    @Delete(":id/permanent")
    hardDelete(@Param("id", uuid) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
      return this.service.hardDelete(id, user, req.ip);
    }
  }

  return BaseCrudController;
}
