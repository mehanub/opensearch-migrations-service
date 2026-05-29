import { Repository, DataSource, In } from 'typeorm';
import { MigrationEntity } from '../../entites/migration.entity';
import { IMigrationRepository, MigrationRecord, MigrationStatus } from '../../interfaces/migration-repository.interface';

export class TypeOrmMigrationRepository implements IMigrationRepository {
  constructor(
    private readonly repo: Repository<MigrationEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS opensearch_migrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        migration_name VARCHAR(255) NOT NULL UNIQUE,
        type VARCHAR(50) NOT NULL,
        version VARCHAR(50),
        index VARCHAR(255) NOT NULL,
        source_index VARCHAR(255),
        alias VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        task_id VARCHAR(255),
        total_docs BIGINT,
        created_docs BIGINT,
        error_message TEXT,
        metadata JSONB,
        started_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);
    await this.dataSource.query(`
      ALTER TABLE opensearch_migrations
        ADD COLUMN IF NOT EXISTS source_index VARCHAR(255),
        ADD COLUMN IF NOT EXISTS total_docs BIGINT,
        ADD COLUMN IF NOT EXISTS created_docs BIGINT;
    `);
  }

  async findInProgressMigrate(): Promise<MigrationRecord[]> {
    const entities = await this.repo.find({ where: { status: 'in_progress', type: 'migrate' } });
    return entities.map(e => this.toRecord(e));
  }

  async findActive(): Promise<MigrationRecord[]> {
    const entities = await this.repo.find({ where: [{ status: 'in_progress' }, { status: 'pending' }] });
    return entities.map(e => this.toRecord(e));
  }

  async findCompleted(): Promise<MigrationRecord[]> {
    const entities = await this.repo.find({ where: { status: 'completed' } });
    return entities.map(e => this.toRecord(e));
  }

  async findOneByNameAndStatuses(name: string, statuses: MigrationStatus[]): Promise<MigrationRecord | null> {
    const entity = await this.repo.findOne({ where: { migrationName: name, status: In(statuses) } });
    return entity ? this.toRecord(entity) : null;
  }

  async findOneById(id: string): Promise<MigrationRecord | null> {
    const entity = await this.repo.findOne({ where: { id } });
    return entity ? this.toRecord(entity) : null;
  }

  async insert(data: Omit<MigrationRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MigrationRecord> {
    const entity = this.repo.create({
      migrationName: data.migrationName,
      type: data.type,
      version: data.version,
      index: data.index,
      alias: data.alias,
      status: data.status,
      startedBy: data.startedBy,
      metadata: data.metadata,
      totalDocs: data.totalDocs,
      createdDocs: data.createdDocs,
      errorMessage: data.errorMessage,
      taskId: data.taskId,
      sourceIndex: data.sourceIndex,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
    });
    const saved = await this.repo.save(entity);
    return this.toRecord(saved);
  }

  async update(id: string, data: Partial<MigrationRecord>): Promise<void> {
    const partial: Partial<MigrationEntity> = {};
    if (data.status !== undefined) partial.status = data.status;
    if (data.taskId !== undefined) partial.taskId = data.taskId;
    if (data.sourceIndex !== undefined) partial.sourceIndex = data.sourceIndex;
    if (data.errorMessage !== undefined) partial.errorMessage = data.errorMessage;
    if (data.totalDocs !== undefined) partial.totalDocs = data.totalDocs;
    if (data.createdDocs !== undefined) partial.createdDocs = data.createdDocs;
    if (data.startedAt !== undefined) partial.startedAt = data.startedAt;
    if (data.completedAt !== undefined) partial.completedAt = data.completedAt;
    if (data.startedBy !== undefined) partial.startedBy = data.startedBy;
    await this.repo.update(id, partial);
  }

  private toRecord(entity: MigrationEntity): MigrationRecord {
    return {
      id: entity.id,
      migrationName: entity.migrationName,
      type: entity.type,
      version: entity.version ?? null,
      status: entity.status,
      totalDocs: entity.totalDocs ?? null,
      createdDocs: entity.createdDocs ?? null,
      errorMessage: entity.errorMessage ?? null,
      taskId: entity.taskId ?? null,
      index: entity.index,
      sourceIndex: entity.sourceIndex ?? null,
      alias: entity.alias,
      metadata: entity.metadata ?? null,
      startedBy: entity.startedBy ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      startedAt: entity.startedAt ?? null,
      completedAt: entity.completedAt ?? null,
    };
  }
}
