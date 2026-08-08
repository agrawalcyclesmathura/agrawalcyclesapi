import { Module } from "@nestjs/common";
import {
  Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req,
  UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { PaginationDto } from "../common/dto/pagination.dto";
import { CurrentUser, RequirePermissions, type AuthUser } from "../auth/decorators";
import { MediaService } from "./media.service";

@ApiTags("media")
@Controller({ path: "media", version: "1" })
class MediaController {
  constructor(private readonly media: MediaService) {}

  @ApiBearerAuth()
  @RequirePermissions("media:view")
  @Get()
  list(@Query() query: PaginationDto & { folder?: string }) {
    return this.media.list(query);
  }

  @ApiBearerAuth()
  @RequirePermissions("media:manage")
  @Post("upload")
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        folder: { type: "string" },
      },
    },
  })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    return this.media.upload(file, (req.body as { folder?: string })?.folder, user, req.ip);
  }

  @ApiBearerAuth()
  @RequirePermissions("media:manage")
  @Delete(":id")
  remove(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.media.remove(id, user, req.ip);
  }
}

@Module({
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
