import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit.service";
import type { AuthUser } from "../../auth/decorators";
import type { CrudQueryDto } from "./crud-query.dto";

export interface CrudServiceOptions {
  /** Prisma delegate key, e.g. "banner" for prisma.banner. */
  model: string;
  /** Human/audit entity name, e.g. "Banner". */
  entity: string;
  searchFields?: string[];
  /** Whitelist of sortable columns (prevents arbitrary orderBy injection). */
  sortable?: string[];
  /** Whitelist of equality-filter columns. */
  filterable?: string[];
  /** Whitelist of boolean columns togglable via bulk-status / statusField. */
  statusFields?: string[];
  softDelete?: boolean;
  /** Integer column used for manual ordering (drag-and-drop). Default "position". */
  orderField?: string;
  /** Model has createdById / updatedById columns. */
  hasAudit?: boolean;
  /** Model has a `version` column for optimistic locking. */
  hasVersion?: boolean;
  defaultSort?: string;
  include?: Record<string, unknown>;
  /** Auto-generate a slug into `slugField` from this source field on create. */
  slugFrom?: string;
  slugField?: string;
  maxLimit?: number;
}

export interface Paginated<T> {
  items: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Generic, reusable CRUD service. Concrete modules extend this and pass their
 * options, gaining pagination, search, multi-sort, filtering, soft-delete/restore,
 * bulk operations, optimistic locking, createdBy/updatedBy and audit logging —
 * all with a single Prisma round-trip per read (no N+1) via `include`.
 */
export abstract class BaseCrudService<T = Record<string, unknown>> {
  protected constructor(
    protected readonly prisma: PrismaService,
    protected readonly audit: AuditService,
    protected readonly options: CrudServiceOptions,
  ) {}

  /** The Prisma model delegate (typed loosely — delegates share no common interface). */
  protected get model(): any {
    const delegate = (this.prisma as unknown as Record<string, unknown>)[this.options.model];
    if (!delegate) throw new Error(`Unknown Prisma model "${this.options.model}"`);
    return delegate;
  }

  private get slugField() {
    return this.options.slugField ?? "slug";
  }

  protected buildWhere(query: Record<string, unknown>): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    const and: unknown[] = [];

    if (this.options.softDelete) {
      if (query.trashed === "only") where.deletedAt = { not: null };
      else if (query.trashed !== "with") where.deletedAt = null;
      // "with" => no deletedAt constraint
    }

    if (query.search && this.options.searchFields?.length) {
      and.push({
        OR: this.options.searchFields.map((f) => ({
          [f]: { contains: String(query.search), mode: "insensitive" },
        })),
      });
    }

    for (const field of this.options.filterable ?? []) {
      const v = query[field];
      if (v === undefined || v === null || v === "") continue;
      const coerced = v === "true" ? true : v === "false" ? false : v;
      and.push({ [field]: coerced });
    }

    if (and.length) where.AND = and;
    return where;
  }

  protected buildOrderBy(sort?: string): Record<string, "asc" | "desc">[] {
    const tokens = (sort ?? this.options.defaultSort ?? "-createdAt")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowed = new Set(this.options.sortable ?? []);
    const orderBy: Record<string, "asc" | "desc">[] = [];
    for (const token of tokens) {
      const desc = token.startsWith("-");
      const field = desc ? token.slice(1) : token;
      if (allowed.size && !allowed.has(field)) continue;
      orderBy.push({ [field]: desc ? "desc" : "asc" });
    }
    if (!orderBy.length) orderBy.push({ createdAt: "desc" });
    return orderBy;
  }

  async findAll(query: CrudQueryDto & Record<string, unknown>): Promise<Paginated<T>> {
    const where = this.buildWhere(query);
    const orderBy = this.buildOrderBy(query.sort);
    const limit = Math.min(query.limit ?? 20, this.options.maxLimit ?? 100);
    const page = query.page ?? 1;
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.model.findMany({ where, orderBy, skip, take: limit, include: this.options.include }),
      this.model.count({ where }),
    ]);
    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 },
    };
  }

  async findOne(id: string, includeDeleted = false): Promise<T> {
    const where =
      this.options.softDelete && !includeDeleted ? { id, deletedAt: null } : { id };
    const row = await this.model.findFirst({ where, include: this.options.include });
    if (!row) throw new NotFoundException(`${this.options.entity} not found`);
    return row;
  }

  private async ensureUniqueSlug(base: string, exceptId?: string): Promise<string> {
    let slug = base || "item";
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const clash = await this.model.findFirst({
        where: { [this.slugField]: slug, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
      });
      if (!clash) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }

  async create(dto: Record<string, unknown>, actor?: AuthUser, ip?: string): Promise<T> {
    const data: Record<string, unknown> = { ...dto };
    delete data.version;

    if (this.options.slugFrom && !data[this.slugField] && data[this.options.slugFrom]) {
      data[this.slugField] = await this.ensureUniqueSlug(slugify(String(data[this.options.slugFrom])));
    }
    if (this.options.hasAudit) {
      data.createdById = actor?.sub ?? null;
      data.updatedById = actor?.sub ?? null;
    }

    const created = await this.model.create({ data, include: this.options.include });
    await this.audit.record({
      actor, action: `${this.options.model}.create`, entity: this.options.entity,
      entityId: created.id, after: created, ip,
    });
    return created;
  }

  async update(id: string, dto: Record<string, unknown>, actor?: AuthUser, ip?: string): Promise<T> {
    const before = (await this.findOne(id, true)) as Record<string, unknown>;

    if (this.options.hasVersion && dto.version !== undefined && before.version !== dto.version) {
      throw new ConflictException(
        `${this.options.entity} was modified by someone else. Reload and try again.`,
      );
    }

    const data: Record<string, unknown> = { ...dto };
    delete data.version;
    if (this.options.slugFrom && data[this.options.slugFrom]) {
      data[this.slugField] = await this.ensureUniqueSlug(
        slugify(String(data[this.options.slugFrom])), id,
      );
    }
    if (this.options.hasAudit) data.updatedById = actor?.sub ?? null;
    if (this.options.hasVersion) data.version = { increment: 1 };

    const updated = await this.model.update({ where: { id }, data, include: this.options.include });
    await this.audit.record({
      actor, action: `${this.options.model}.update`, entity: this.options.entity,
      entityId: id, before, after: updated, ip,
    });
    return updated;
  }

  async remove(id: string, actor?: AuthUser, ip?: string): Promise<{ success: true; id: string }> {
    const before = (await this.findOne(id, true)) as Record<string, unknown>;
    if (this.options.softDelete) {
      await this.model.update({
        where: { id },
        data: { deletedAt: new Date(), ...(this.options.hasAudit ? { updatedById: actor?.sub ?? null } : {}) },
      });
    } else {
      await this.model.delete({ where: { id } });
    }
    await this.audit.record({
      actor, action: `${this.options.model}.delete`, entity: this.options.entity,
      entityId: id, before, ip,
    });
    return { success: true, id };
  }

  async restore(id: string, actor?: AuthUser, ip?: string): Promise<T> {
    if (!this.options.softDelete) {
      throw new BadRequestException(`${this.options.entity} does not support restore`);
    }
    await this.findOne(id, true);
    const restored = await this.model.update({
      where: { id },
      data: { deletedAt: null, ...(this.options.hasAudit ? { updatedById: actor?.sub ?? null } : {}) },
      include: this.options.include,
    });
    await this.audit.record({
      actor, action: `${this.options.model}.restore`, entity: this.options.entity,
      entityId: id, after: restored, ip,
    });
    return restored;
  }

  /** Permanent delete — controller restricts this to Super Admin. */
  async hardDelete(id: string, actor?: AuthUser, ip?: string): Promise<{ success: true; id: string }> {
    const before = await this.model.findUnique({ where: { id } });
    if (!before) throw new NotFoundException(`${this.options.entity} not found`);
    await this.model.delete({ where: { id } });
    await this.audit.record({
      actor, action: `${this.options.model}.hardDelete`, entity: this.options.entity,
      entityId: id, before, ip,
    });
    return { success: true, id };
  }

  async bulkDelete(ids: string[], actor?: AuthUser, ip?: string): Promise<{ count: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const model = (tx as unknown as Record<string, any>)[this.options.model];
      return this.options.softDelete
        ? model.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } })
        : model.deleteMany({ where: { id: { in: ids } } });
    });
    await this.audit.record({
      actor, action: `${this.options.model}.bulkDelete`, entity: this.options.entity,
      after: { ids, count: result.count }, ip,
    });
    return { count: result.count };
  }

  async bulkRestore(ids: string[], actor?: AuthUser, ip?: string): Promise<{ count: number }> {
    if (!this.options.softDelete) {
      throw new BadRequestException(`${this.options.entity} does not support restore`);
    }
    const result = await this.model.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: null },
    });
    await this.audit.record({
      actor, action: `${this.options.model}.bulkRestore`, entity: this.options.entity,
      after: { ids, count: result.count }, ip,
    });
    return { count: result.count };
  }

  /** Persist a new manual order: sets orderField = index for each id, transactionally. */
  async reorder(ids: string[], actor?: AuthUser, ip?: string): Promise<{ count: number }> {
    const field = this.options.orderField ?? "position";
    await this.prisma.$transaction(
      ids.map((id, index) => this.model.update({ where: { id }, data: { [field]: index } })),
    );
    await this.audit.record({
      actor, action: `${this.options.model}.reorder`, entity: this.options.entity,
      after: { ids }, ip,
    });
    return { count: ids.length };
  }

  async bulkStatus(
    ids: string[], field: string, value: boolean, actor?: AuthUser, ip?: string,
  ): Promise<{ count: number }> {
    if (!this.options.statusFields?.includes(field)) {
      throw new BadRequestException(`Field "${field}" cannot be bulk-updated`);
    }
    const result = await this.model.updateMany({
      where: { id: { in: ids } },
      data: { [field]: value },
    });
    await this.audit.record({
      actor, action: `${this.options.model}.bulkStatus`, entity: this.options.entity,
      after: { ids, field, value, count: result.count }, ip,
    });
    return { count: result.count };
  }
}
