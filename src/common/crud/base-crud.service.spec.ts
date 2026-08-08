import { BadRequestException, ConflictException } from "@nestjs/common";
import { BaseCrudService, type CrudServiceOptions } from "./base-crud.service";

/** Concrete subclass exposing the protected query builders for assertion. */
class TestService extends BaseCrudService {
  constructor(prisma: any, audit: any, options: CrudServiceOptions) {
    super(prisma, audit, options);
  }
  where(q: Record<string, unknown>) {
    return this.buildWhere(q);
  }
  order(sort?: string) {
    return this.buildOrderBy(sort);
  }
}

const OPTIONS: CrudServiceOptions = {
  model: "banner",
  entity: "Banner",
  searchFields: ["title", "subtitle"],
  sortable: ["position", "createdAt", "title"],
  filterable: ["placement", "isActive"],
  statusFields: ["isActive"],
  softDelete: true,
  hasAudit: true,
  hasVersion: true,
  defaultSort: "position",
};

const audit = { record: jest.fn() };

describe("BaseCrudService", () => {
  describe("buildWhere (soft-delete scoping)", () => {
    const svc = new TestService({}, audit, OPTIONS);
    it("excludes soft-deleted rows by default", () => {
      expect(svc.where({})).toEqual({ deletedAt: null });
    });
    it("trashed=only returns only soft-deleted rows", () => {
      expect(svc.where({ trashed: "only" })).toEqual({ deletedAt: { not: null } });
    });
    it("trashed=with removes the deletedAt constraint", () => {
      expect(svc.where({ trashed: "with" })).toEqual({});
    });
  });

  describe("buildWhere (search + filters)", () => {
    const svc = new TestService({}, audit, OPTIONS);
    it("builds a case-insensitive OR across searchFields", () => {
      const w = svc.where({ search: "sale" }) as any;
      expect(w.AND).toEqual([
        {
          OR: [
            { title: { contains: "sale", mode: "insensitive" } },
            { subtitle: { contains: "sale", mode: "insensitive" } },
          ],
        },
      ]);
    });
    it("coerces string booleans and applies whitelisted filters", () => {
      const w = svc.where({ isActive: "true", placement: "hero" }) as any;
      expect(w.AND).toContainEqual({ isActive: true });
      expect(w.AND).toContainEqual({ placement: "hero" });
    });
    it("ignores non-whitelisted filter keys", () => {
      const w = svc.where({ isAdmin: "true" }) as any;
      expect(w.AND).toBeUndefined();
    });
  });

  describe("buildOrderBy (multi-sort + whitelist)", () => {
    const svc = new TestService({}, audit, OPTIONS);
    it("parses multiple columns with '-' desc prefix", () => {
      expect(svc.order("-position,title")).toEqual([{ position: "desc" }, { title: "asc" }]);
    });
    it("drops non-whitelisted sort fields (SQL-injection guard) and falls back", () => {
      expect(svc.order("passwordHash")).toEqual([{ createdAt: "desc" }]);
    });
    it("uses defaultSort when none provided", () => {
      expect(svc.order(undefined)).toEqual([{ position: "asc" }]);
    });
  });

  describe("optimistic locking", () => {
    it("throws Conflict when the supplied version is stale", async () => {
      const prisma = { banner: { findFirst: jest.fn().mockResolvedValue({ id: "1", version: 3 }) } };
      const svc = new TestService(prisma, audit, OPTIONS);
      await expect(svc.update("1", { version: 1 }, undefined)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("bulkStatus whitelist", () => {
    it("rejects a field that is not in statusFields", async () => {
      const svc = new TestService({}, audit, OPTIONS);
      await expect(svc.bulkStatus(["1"], "createdAt", false, undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
