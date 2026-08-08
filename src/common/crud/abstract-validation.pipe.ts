import {
  ArgumentMetadata,
  Injectable,
  Type,
  ValidationPipe,
  ValidationPipeOptions,
} from "@nestjs/common";

/**
 * A ValidationPipe that injects an explicit target class for a given argument
 * kind (body/query/param). This lets the generic CrudController factory validate
 * per-module DTOs even though its handler signatures are typed generically.
 */
@Injectable()
export class AbstractValidationPipe extends ValidationPipe {
  constructor(
    options: ValidationPipeOptions,
    private readonly targets: { body?: Type<unknown>; query?: Type<unknown>; param?: Type<unknown> },
  ) {
    super(options);
  }

  async transform(value: unknown, metadata: ArgumentMetadata) {
    const target = this.targets[metadata.type as "body" | "query" | "param"];
    if (!target) return value; // leave untargeted args (e.g. @Param id, @CurrentUser) untouched
    return super.transform(value, { ...metadata, metatype: target });
  }
}
