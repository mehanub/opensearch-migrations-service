import { ColumnType, Generated } from 'kysely';

export interface OpenSearchMigrationsTable {
  id: Generated<string>;
  migration_name: string;
  type: 'create' | 'migrate';
  version: string | null;
  status: string;
  total_docs: number | null;
  created_docs: number | null;
  error_message: string | null;
  task_id: string | null;
  index: string;
  source_index: string | null;
  alias: string;
  metadata: Record<string, any> | null;
  started_by: string | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface MigrationsDatabase {
  opensearch_migrations: OpenSearchMigrationsTable;
}
