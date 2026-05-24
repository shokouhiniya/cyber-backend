import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GlobalContext } from './global-context.entity';

/**
 * Shared context values used by every profile's prompts.
 * v1 keeps it as a simple key→value store. The AiContentService pulls all rows
 * and merges them into input_vars as `global_<key>` before each Promtic call.
 */
@Injectable()
export class GlobalContextService {
  constructor(
    @InjectRepository(GlobalContext)
    private readonly repo: Repository<GlobalContext>,
  ) {}

  async list() {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  async get(key: string) {
    return this.repo.findOne({ where: { key } });
  }

  async upsert(key: string, value: string, userId: string) {
    const existing = await this.get(key);
    if (existing) {
      existing.value = value;
      existing.updatedBy = userId;
      return this.repo.save(existing);
    }
    return this.repo.save(
      this.repo.create({ key, value, updatedBy: userId }),
    );
  }

  async remove(key: string) {
    await this.repo.delete({ key });
    return { key, deleted: true };
  }

  /**
   * Returns a flat { global_<key>: value } map ready to merge into
   * Promtic input_vars.
   */
  async asInputVars(): Promise<Record<string, string>> {
    const rows = await this.repo.find();
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[`global_${r.key}`] = r.value ?? '';
    }
    return out;
  }
}
