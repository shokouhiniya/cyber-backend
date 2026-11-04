import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataSource } from './data-source.entity';
import { DataSourceApiService } from './data-source-api.service';

@Injectable()
export class DataSourceService {
  private readonly logger = new Logger(DataSourceService.name);

  constructor(
    @InjectRepository(DataSource)
    private readonly dataSourceRepository: Repository<DataSource>,
    private readonly dataSourceApiService: DataSourceApiService,
  ) {}

  async findAll(): Promise<DataSource[]> {
    return this.dataSourceRepository.find();
  }

  async findByProfile(profileId: string): Promise<DataSource[]> {
    return this.dataSourceRepository.find({
      where: { profileId },
      order: { createdAt: 'DESC' },
    });
  }

  async findActive(): Promise<DataSource[]> {
    return this.dataSourceRepository.find({ where: { isActive: true } });
  }

  async findByType(type: string): Promise<DataSource[]> {
    return this.dataSourceRepository.find({
      where: { type, isActive: true },
    });
  }

  async findById(id: string): Promise<DataSource | null> {
    return this.dataSourceRepository.findOne({ where: { id } });
  }

  async getOrThrow(id: string): Promise<DataSource> {
    const found = await this.findById(id);
    if (!found) throw new NotFoundException('منبع داده یافت نشد');
    return found;
  }

  async create(data: Partial<DataSource>): Promise<DataSource> {
    const dataSource = this.dataSourceRepository.create(data);
    return this.dataSourceRepository.save(dataSource);
  }

  async update(id: string, data: Partial<DataSource>): Promise<DataSource> {
    const existing = await this.getOrThrow(id);
    Object.assign(existing, data);
    return this.dataSourceRepository.save(existing);
  }

  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    await this.getOrThrow(id);
    await this.dataSourceRepository.delete(id);
    return { id, deleted: true };
  }

  async updateLastFetch(id: string, status: string = 'success', error?: string): Promise<void> {
    await this.dataSourceRepository.update(id, {
      lastFetchAt: new Date(),
      lastRunStatus: status,
      lastError: error ?? undefined,
    });
  }

  async toggleActive(id: string, isActive: boolean): Promise<void> {
    await this.dataSourceRepository.update(id, { isActive });
  }

  /**
   * Whether a data source is the primary (8tag) provider. Matched by name or by
   * API endpoint, so an admin can rename the source (the client wants no
   * provider name shown) without breaking it.
   */
  private isPrimaryProvider(dataSource: { name?: string | null; apiEndpoint?: string | null }): boolean {
    const name = dataSource.name || '';
    return name.includes('8tag') || name.includes('هشتک') || /8tag\.ir/i.test(dataSource.apiEndpoint || '');
  }

  async testConnection(id: string, paramsOverride?: any): Promise<any> {
    const dataSource = await this.getOrThrow(id);
    const params = { ...(dataSource.params || {}), ...(paramsOverride || {}) };

    if (this.isPrimaryProvider(dataSource)) {
      return this.dataSourceApiService.test8tag(dataSource.credentials, params);
    }

    throw new NotFoundException('این منبع داده پشتیبانی نمی‌شود. در حال حاضر فقط منبع داده اصلی سامانه فعال است.');
  }

  /**
   * Runs the source and marks last_fetch_at + last_run_status.
   * In v1 there's no scheduler — this is invoked manually from the admin UI.
   */
  async runNow(id: string, paramsOverride?: any): Promise<any> {
    try {
      const result = await this.testConnection(id, paramsOverride);
      await this.updateLastFetch(id, 'success');
      return result;
    } catch (err: any) {
      await this.updateLastFetch(id, 'error', err?.message || String(err));
      throw err;
    }
  }

  async search(id: string, paramsOverride?: any): Promise<any> {
    const dataSource = await this.getOrThrow(id);
    const params = { ...(dataSource.params || {}), ...(paramsOverride || {}) };

    if (this.isPrimaryProvider(dataSource)) {
      return this.dataSourceApiService.search8tag(dataSource.credentials, params);
    }

    throw new NotFoundException('این منبع از جستجو پشتیبانی نمی‌کند');
  }

  async listPages(id: string): Promise<any> {
    const dataSource = await this.getOrThrow(id);
    if (this.isPrimaryProvider(dataSource)) {
      return this.dataSourceApiService.list8tagPages(dataSource.credentials);
    }
    throw new NotFoundException('این منبع لیست صفحات را پشتیبانی نمی‌کند');
  }
}
