export type MigrationStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type MigrationType = 'create' | 'migrate';

export interface MigrationRecord {
  id: string;
  migrationName: string;
  type: MigrationType;
  version: string | null;
  status: MigrationStatus;
  totalDocs: number | null;
  createdDocs: number | null;
  errorMessage: string | null;
  taskId: string | null;
  index: string;
  sourceIndex: string | null;
  alias: string;
  metadata: Record<string, any> | null;
  startedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface IMigrationRepository {
  ensureSchema(): Promise<void>;
  findInProgressMigrate(): Promise<MigrationRecord[]>;
  findActive(): Promise<MigrationRecord[]>;
  findCompleted(): Promise<MigrationRecord[]>;
  findOneByNameAndStatuses(name: string, statuses: MigrationStatus[]): Promise<MigrationRecord | null>;
  findOneById(id: string): Promise<MigrationRecord | null>;
  insert(data: Omit<MigrationRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MigrationRecord>;
  update(id: string, data: Partial<MigrationRecord>): Promise<void>;
}
