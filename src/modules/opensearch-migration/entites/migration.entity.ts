import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('opensearch_migrations')
@Index(['status', 'createdAt'])
@Index(['migrationName', 'status'])
export class MigrationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'migration_name', unique: true })
  migrationName: string;

  @Column({ name: 'type', type:'varchar'})
  type: 'create' | 'migrate';

  @Column({ name: 'version', nullable: true })
  version: string;

  @Column({ type: 'varchar', length: 50, default: 'pending' })
  status: 'pending' | 'in_progress' | 'completed' | 'failed' ;

  @Column({ type: 'bigint', nullable: true })
  totalDocs: number;

  @Column({ type: 'bigint', nullable: true })
  createdDocs: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({type:'varchar', nullable: true})
  taskId: string;

  @Column({type: 'varchar'})
  index: string;

  @Column({ name: 'source_index', type: 'varchar', nullable: true })
  sourceIndex: string;

  @Column({type: 'varchar'})
  alias: string

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ name: 'started_by', nullable: true })
  startedBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'started_at', nullable: true })
  startedAt: Date;

  @Column({ name: 'completed_at', nullable: true })
  completedAt: Date;
}