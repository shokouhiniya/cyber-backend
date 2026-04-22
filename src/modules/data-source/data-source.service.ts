import { Injectable, Logger } from '@nestjs/common';
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

  async findActive(): Promise<DataSource[]> {
    return this.dataSourceRepository.find({
      where: { isActive: true },
    });
  }

  async findByType(type: string): Promise<DataSource[]> {
    return this.dataSourceRepository.find({
      where: { type, isActive: true },
    });
  }

  async findById(id: string): Promise<DataSource | null> {
    return this.dataSourceRepository.findOne({ where: { id } });
  }

  async create(data: Partial<DataSource>): Promise<DataSource> {
    const dataSource = this.dataSourceRepository.create(data);
    return this.dataSourceRepository.save(dataSource);
  }

  async updateLastFetch(id: string): Promise<void> {
    await this.dataSourceRepository.update(id, {
      lastFetchAt: new Date(),
    });
  }

  async toggleActive(id: string, isActive: boolean): Promise<void> {
    await this.dataSourceRepository.update(id, { isActive });
  }

  async testConnection(id: string, params: any): Promise<any> {
    const dataSource = await this.findById(id);
    
    if (!dataSource) {
      throw new Error('Data source not found');
    }

    // Route to appropriate API service based on data source name
    if (dataSource.name.includes('Dataak')) {
      return this.dataSourceApiService.testDataak(dataSource.credentials, params);
    } else if (dataSource.name.includes('8tag')) {
      return this.dataSourceApiService.test8tag(dataSource.credentials, params);
    } else if (dataSource.name.includes('Datami')) {
      return this.dataSourceApiService.testDatami(dataSource.credentials, params);
    } else if (dataSource.name.includes('Mahta')) {
      return this.dataSourceApiService.testMahta(dataSource.credentials, params);
    }

    throw new Error('Unknown data source type');
  }

  async listPages(id: string): Promise<any> {
    const dataSource = await this.findById(id);
    
    if (!dataSource) {
      throw new Error('Data source not found');
    }

    // Only 8tag supports pages listing for now
    if (dataSource.name.includes('8tag')) {
      return this.dataSourceApiService.list8tagPages(dataSource.credentials);
    }

    throw new Error('This data source does not support pages listing');
  }
}
