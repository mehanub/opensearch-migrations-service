import { Kysely, sql } from 'kysely';
import { IMigrationRepository, MigrationRecord, MigrationStatus } from '../../interfaces/migration-repository.interface';
import { MigrationsDatabase } from './kysely.types';

export class KyselyMigrationRepository implements IMigrationRepository {
  constructor(private readonly db: Kysely<MigrationsDatabase>) {}

  async ensureSchema(): Promise<void> {
    await this.db.schema
      .createTable('opensearch_migrations')
      .ifNotExists()
      .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('migration_name', sql`varchar(255)`, col => col.notNull().unique())
      .addColumn('type', sql`varchar(50)`, col => col.notNull())
      .addColumn('version', sql`varchar(50)`)
      .addColumn('index', sql`varchar(255)`, col => col.notNull())
      .addColumn('source_index', sql`varchar(255)`)
      .addColumn('alias', sql`varchar(255)`, col => col.notNull())
      .addColumn('status', sql`varchar(50)`, col => col.defaultTo('pending'))
      .addColumn('task_id', sql`varchar(255)`)
      .addColumn('total_docs', 'bigint')
      .addColumn('created_docs', 'bigint')
      .addColumn('error_message', 'text')
      .addColumn('metadata', 'jsonb')
      .addColumn('started_by', sql`varchar(255)`)
      .addColumn('created_at', 'timestamp', col => col.defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamp', col => col.defaultTo(sql`now()`))
      .addColumn('started_at', 'timestamp')
      .addColumn('completed_at', 'timestamp')
      .execute();
  }

  async findInProgressMigrate(): Promise<MigrationRecord[]> {
    const rows = await this.db
      .selectFrom('opensearch_migrations')
      .selectAll()
      .where('status', '=', 'in_progress')
      .where('type', '=', 'migrate')
      .execute();
    return rows.map(r => this.toRecord(r));
  }

  async findActive(): Promise<MigrationRecord[]> {
    const rows = await this.db
      .selectFrom('opensearch_migrations')
      .selectAll()
      .where('status', 'in', ['in_progress', 'pending'])
      .execute();
    return rows.map(r => this.toRecord(r));
  }

  async findCompleted(): Promise<MigrationRecord[]> {
    const rows = await this.db
      .selectFrom('opensearch_migrations')
      .selectAll()
      .where('status', '=', 'completed')
      .execute();
    return rows.map(r => this.toRecord(r));
  }

  async findOneByNameAndStatuses(name: string, statuses: MigrationStatus[]): Promise<MigrationRecord | null> {
    const row = await this.db
      .selectFrom('opensearch_migrations')
      .selectAll()
      .where('migration_name', '=', name)
      .where('status', 'in', statuses)
      .executeTakeFirst();
    return row ? this.toRecord(row) : null;
  }

  async findOneById(id: string): Promise<MigrationRecord | null> {
    const row = await this.db
      .selectFrom('opensearch_migrations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.toRecord(row) : null;
  }

  async insert(data: Omit<MigrationRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MigrationRecord> {
    const row = await this.db
      .insertInto('opensearch_migrations')
      .values({
        migration_name: data.migrationName,
        type: data.type,
        version: data.version ?? null,
        index: data.index,
        source_index: data.sourceIndex ?? null,
        alias: data.alias,
        status: data.status,
        task_id: data.taskId ?? null,
        total_docs: data.totalDocs ?? null,
        created_docs: data.createdDocs ?? null,
        error_message: data.errorMessage ?? null,
        metadata: data.metadata ?? null,
        started_by: data.startedBy ?? null,
        started_at: data.startedAt ?? null,
        completed_at: data.completedAt ?? null,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toRecord(row);
  }

  async update(id: string, data: Partial<MigrationRecord>): Promise<void> {
    const cols: Record<string, any> = { updated_at: new Date() };
    if (data.status !== undefined) cols.status = data.status;
    if (data.taskId !== undefined) cols.task_id = data.taskId;
    if (data.sourceIndex !== undefined) cols.source_index = data.sourceIndex;
    if (data.errorMessage !== undefined) cols.error_message = data.errorMessage;
    if (data.totalDocs !== undefined) cols.total_docs = data.totalDocs;
    if (data.createdDocs !== undefined) cols.created_docs = data.createdDocs;
    if (data.startedAt !== undefined) cols.started_at = data.startedAt;
    if (data.completedAt !== undefined) cols.completed_at = data.completedAt;
    if (data.startedBy !== undefined) cols.started_by = data.startedBy;

    await this.db
      .updateTable('opensearch_migrations')
      .set(cols)
      .where('id', '=', id)
      .execute();
  }

  private toRecord(row: any): MigrationRecord {
    return {
      id: row.id,
      migrationName: row.migration_name,
      type: row.type,
      version: row.version ?? null,
      status: row.status,
      totalDocs: row.total_docs ?? null,
      createdDocs: row.created_docs ?? null,
      errorMessage: row.error_message ?? null,
      taskId: row.task_id ?? null,
      index: row.index,
      sourceIndex: row.source_index ?? null,
      alias: row.alias,
      metadata: row.metadata ?? null,
      startedBy: row.started_by ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
    };
  }
}
