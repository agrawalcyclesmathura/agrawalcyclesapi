import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { paginate, PaginationDto } from "../common/dto/pagination.dto";
import type { AuthUser } from "../auth/decorators";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), "uploads");
const PUBLIC_BASE = process.env.MEDIA_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const MAX_WIDTH = 1600;
const THUMB = 400;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
// Raster formats only — SVG is intentionally excluded (script/XSS vector).
const ALLOWED_FORMATS = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif"]);

/**
 * Reusable media service: validates, optimizes (sharp → WebP), generates a
 * thumbnail, dedupes by content hash, persists to the Media library and serves
 * from `/uploads`. Injectable by any module that needs to attach images.
 */
@Injectable()
export class MediaService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async list(query: PaginationDto & { folder?: string }) {
    const where = query.folder ? { folder: query.folder } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.media.findMany({
        where, orderBy: { createdAt: "desc" }, skip: query.skip, take: query.limit,
      }),
      this.prisma.media.count({ where }),
    ]);
    return paginate(items, total, query);
  }

  async upload(file: Express.Multer.File, folder: string | undefined, actor?: AuthUser, ip?: string) {
    // --- Safe validation (OWASP: never trust the client-declared type) ---
    if (!file) throw new BadRequestException("No file provided");
    if (file.size > MAX_BYTES) throw new BadRequestException("File exceeds 10 MB limit");

    let meta: sharp.Metadata;
    try {
      meta = await sharp(file.buffer).metadata();
    } catch {
      throw new BadRequestException("File is not a valid image");
    }
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
      throw new BadRequestException(`Unsupported image format: ${meta.format ?? "unknown"}`);
    }

    // --- Dedupe by content hash ---
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    const existing = await this.prisma.media.findFirst({ where: { key: { startsWith: hash.slice(0, 16) } } });
    if (existing) return existing;

    const sub = (folder ?? "general").replace(/[^a-z0-9/_-]/gi, "") || "general";
    const dir = join(UPLOAD_DIR, sub);
    await mkdir(dir, { recursive: true });

    const base = `${hash.slice(0, 16)}-${randomUUID().slice(0, 8)}`;
    const mainName = `${base}.webp`;
    const thumbName = `${base}-thumb.webp`;

    const optimized = await sharp(file.buffer)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const thumbnail = await sharp(file.buffer)
      .rotate()
      .resize({ width: THUMB, height: THUMB, fit: "cover" })
      .webp({ quality: 72 })
      .toBuffer();

    await writeFile(join(dir, mainName), optimized);
    await writeFile(join(dir, thumbName), thumbnail);

    const relKey = `${sub}/${mainName}`;
    const dims = await sharp(optimized).metadata();
    const media = await this.prisma.media.create({
      data: {
        url: `${PUBLIC_BASE}/uploads/${relKey}`,
        thumbnailUrl: `${PUBLIC_BASE}/uploads/${sub}/${thumbName}`,
        key: relKey,
        mimeType: "image/webp",
        size: optimized.length,
        folder: sub,
        width: dims.width ?? meta.width ?? null,
        height: dims.height ?? meta.height ?? null,
        createdById: actor?.sub ?? null,
      },
    });
    await this.audit.record({
      actor, action: "media.upload", entity: "Media", entityId: media.id, after: { key: relKey }, ip,
    });
    return media;
  }

  async remove(id: string, actor?: AuthUser, ip?: string) {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) throw new NotFoundException("Media not found");
    await unlink(join(UPLOAD_DIR, media.key)).catch(() => undefined);
    if (media.thumbnailUrl) {
      const thumbKey = media.key.replace(/\.webp$/, "-thumb.webp");
      await unlink(join(UPLOAD_DIR, thumbKey)).catch(() => undefined);
    }
    await this.prisma.media.delete({ where: { id } });
    await this.audit.record({
      actor, action: "media.delete", entity: "Media", entityId: id, before: { key: media.key }, ip,
    });
    return { success: true };
  }
}
