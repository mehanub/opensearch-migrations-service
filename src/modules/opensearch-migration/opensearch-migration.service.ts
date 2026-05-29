import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Client } from '@opensearch-project/opensearch';
import { MigrationConfig } from './interfaces/migration.interface';
import { IMigrationRepository, MigrationRecord } from './interfaces/migration-repository.interface';
import { OpenSearchService, DualWriteTarget } from './opensearch.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class OpenSearchMigrationService implements OnModuleInit {
  private readonly logger = new Logger(OpenSearchMigrationService.name);
  private migrations: Map<string, MigrationConfig> = new Map();
  private migrationsPath: string;
  private activeTaskIds: Set<string> = new Set();
  private isProcessing = false;

  constructor(
    @Inject('MIGRATION_REPOSITORY')
    private readonly migrationRepository: IMigrationRepository,
    @Inject('OPENSEARCH_CLIENT')
    private readonly opensearchClient?: Client,
    @Optional() @Inject('MIGRATIONS_PATH') customPath?: string,
    @Optional() private readonly dualWriteService?: OpenSearchService,
  ) {
    this.migrationsPath = customPath || process.env.MIGRATIONS_PATH || './src/migrations/opensearch';
  }

  async onModuleInit() {
    await this.migrationRepository.ensureSchema();
    await this.loadMigrationsFromDirectory();
    await this.resumePendingMigrations();
    await this.runPendingMigrations();
    await this.syncDualWriteTargets();

    this.logger.log(`OpenSearch Migration Service initialized. Loaded ${this.migrations.size} migrations`);
  }

  private async syncDualWriteTargets(): Promise<void> {
    if (!this.dualWriteService) return;

    const active = await this.migrationRepository.findInProgressMigrate();

    const targets = new Map<string, DualWriteTarget>();
    for (const m of active) {
      if (m.sourceIndex) {
        targets.set(m.alias, { sourceIndex: m.sourceIndex, destIndex: m.index });
      }
    }

    this.dualWriteService.setTargets(targets);
  }

  private async loadMigrationsFromDirectory() {
    const absolutePath = path.isAbsolute(this.migrationsPath)
      ? this.migrationsPath
      : path.join(process.cwd(), this.migrationsPath);

    if (!fs.existsSync(absolutePath)) {
      this.logger.warn(`Migrations directory not found: ${absolutePath}`);
      return;
    }

    const files = fs.readdirSync(absolutePath).filter(file => file.endsWith('.json')).sort();

    for (const file of files) {
      try {
        const filePath = path.join(absolutePath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const migration: MigrationConfig = JSON.parse(content);

        const migrationName = path.basename(file, '.json');
        this.migrations.set(migrationName, migration);
        this.logger.log(`Loaded migration: ${migrationName} -> ${migration.index} ${migration.version || 'v1'}`);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed: ${errorMessage}`);
      }
    }
  }

  private async resumePendingMigrations() {
    const pending = await this.migrationRepository.findActive();

    for (const migration of pending) {
      if (migration.taskId) {
        this.logger.log(`Resuming monitoring for migration: ${migration.migrationName}`);
        this.activeTaskIds.add(migration.taskId);
      }
    }
  }

  private async runPendingMigrations() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const completedMigrations = await this.migrationRepository.findCompleted();

      const completedNames = new Set(completedMigrations.map(m => m.migrationName));
      const newMigrations = Array.from(this.migrations.keys())
        .filter(name => !completedNames.has(name))
        .sort();

      if (newMigrations.length === 0) {
        this.logger.log('No new migrations to run');
        return;
      }

      this.logger.log(`Found ${newMigrations.length} new migration(s): ${newMigrations.join(', ')}`);

      for (const migrationName of newMigrations) {
        const config = this.migrations.get(migrationName);
        if (!config) continue;

        const alreadyStarted = await this.migrationRepository.findOneByNameAndStatuses(
          migrationName,
          ['pending', 'in_progress'],
        );

        if (alreadyStarted) {
          this.logger.log(`Migration ${migrationName} already in progress, skipping`);
          continue;
        }

        await this.startMigration(migrationName, config, 'auto-start');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed: ${errorMessage}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private async startMigration(migrationName: string, config: MigrationConfig, startedBy: string = 'auto-start') {
    const nextIndexName = await this.getNextIndexName(config);

    const migration = await this.migrationRepository.insert({
      migrationName,
      type: config.type,
      version: config.version ?? null,
      index: nextIndexName,
      alias: config.alias,
      status: 'pending',
      startedBy,
      metadata: config,
      totalDocs: null,
      createdDocs: null,
      errorMessage: null,
      taskId: null,
      sourceIndex: null,
      startedAt: null,
      completedAt: null,
    });

    this.logger.log(`Created migration record: ${migrationName} (${migration.id})`);

    const migrationRecord = await this.migrationRepository.findOneById(migration.id);
    if (!migrationRecord) return;

    switch (config.type) {
      case 'create':
        await this.executeCreateScheme(migration, config);
        break;
      case 'migrate':
        await this.executeMigrateScheme(migration, config);
        break;
      default:
        this.logger.error(`Definition type ${config.type} not supported`);
        process.exit(1);
    }
  }

  async executeMigrateScheme(migration: MigrationRecord, config: MigrationConfig) {
    try {
      await this.migrationRepository.update(migration.id, {
        status: 'in_progress',
        startedAt: new Date(),
      });

      const sourceIndex = await this.getCurrentIndexName(config.alias);

      const lastIndexVersionString = sourceIndex.split('-').pop();
      const lastIndexVersion = parseInt(lastIndexVersionString?.slice(1) ?? '0');

      if (lastIndexVersion === 0) {
        this.logger.error(`Index '${config.index}' has no versions. Fatal error.`);
        process.exit(1);
      }

      this.logger.log(`Creating index: ${migration.index}`);
      await this.opensearchClient.indices.create({
        index: migration.index,
        body: {
          mappings: config.values.mappings,
        },
      });

      this.logger.log(`Starting reindex from ${sourceIndex} to ${migration.index}`);

      const reindexBody: any = {
        conflicts: 'proceed',
        source: { index: sourceIndex },
        dest: { index: migration.index, op_type: 'create' },
      };

      if (config.transform?.script) {
        reindexBody.script = {
          source: config.transform.script,
          lang: 'painless',
        };
      }

      const reindexResponse = await this.opensearchClient.reindex({
        wait_for_completion: false,
        body: reindexBody,
      });

      const taskId = reindexResponse.body.task;

      await this.migrationRepository.update(migration.id, {
        taskId,
        sourceIndex,
      });

      this.activeTaskIds.add(taskId);
      this.logger.log(`Reindex started: ${taskId}`);
      await this.syncDualWriteTargets();
    } catch (error) {
      await this.migrationRepository.update(migration.id, {
        status: 'failed',
        errorMessage: 'error',
        completedAt: new Date(),
      });
      process.exit(1);
    }
  }

  async executeCreateScheme(migration: MigrationRecord, config: MigrationConfig) {
    if (!this.opensearchClient) {
      throw new Error('OpenSearch client not available');
    }

    try {
      await this.migrationRepository.update(migration.id, {
        status: 'in_progress',
        startedAt: new Date(),
      });

      const response = await this.opensearchClient.indices.get({ index: `${migration.index}` }, { ignore: [404] });
      if (response.statusCode === 200) {
        this.logger.log(`Index ${migration.index} already exists, skipping...`);
        throw (`Index ${migration.index} already exists, skipping...`);
      }

      const aliasResponse = await this.opensearchClient.indices.getAlias({ name: config.alias }, { ignore: [404] });
      if (aliasResponse.statusCode === 200) {
        throw (`Index ${migration.index} already exists, skipping...`);
      }

      this.logger.log(`Creating index: ${migration.index}`);
      await this.opensearchClient.indices.create({
        index: migration.index,
        body: {
          mappings: config.values.mappings,
        },
      });

      await this.opensearchClient.indices.putAlias({ index: `${migration.index}`, name: `${config.alias}` });

      await this.migrationRepository.update(migration.id, {
        status: 'completed',
        completedAt: new Date(),
      });
    } catch (error) {
      await this.migrationRepository.update(migration.id, {
        status: 'failed',
        errorMessage: 'error',
        completedAt: new Date(),
      });
      process.exit(1);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkActiveMigrations() {
    if (this.activeTaskIds.size === 0) return;

    const activeMigrations = await this.migrationRepository.findInProgressMigrate();

    for (const migration of activeMigrations) {
      if (!migration.taskId || !this.opensearchClient) continue;

      try {
        const status = await this.opensearchClient.tasks.get({ task_id: migration.taskId });

        if (status.body.completed) {
          const response = status.body.response;
          const config = this.migrations.get(migration.migrationName);

          const validationError = await this.validateMigration(migration, config);
          if (validationError) {
            this.logger.error(`❌ Migration ${migration.migrationName} validation failed: ${validationError}`);
            await this.failMigration(migration, `Validation failed: ${validationError}`);
            continue;
          }

          await this.switchAliasToNewIndex(migration.index, migration.alias);
          await this.completeMigration(migration, response.total, response.created);
        } else if (status.body.error) {
          this.logger.error(`❌ Migration ${migration.migrationName} failed: ${status.body.error.reason}`);
          await this.failMigration(migration, status.body.error.reason);
        }
      } catch (error: any) {
        if (error.statusCode === 404) {
          this.logger.warn(`Task ${migration.taskId} not found`);
          await this.failMigration(migration, `Task not found: ${error.message}`);
        }
      }
    }
  }

  private async failMigration(migration: MigrationRecord, errorMessage: string): Promise<void> {
    await this.migrationRepository.update(migration.id, {
      status: 'failed',
      errorMessage,
      completedAt: new Date(),
    });
    if (migration.taskId) this.activeTaskIds.delete(migration.taskId);
    await this.syncDualWriteTargets();
  }

  private async completeMigration(migration: MigrationRecord, totalDocs: number, createdDocs: number): Promise<void> {
    this.activeTaskIds.delete(migration.taskId);
    await this.migrationRepository.update(migration.id, {
      status: 'completed',
      totalDocs,
      createdDocs,
      completedAt: new Date(),
    });
    await this.syncDualWriteTargets();
    this.logger.log(`✅ Migration ${migration.migrationName} completed! (${createdDocs} docs created)`);
  }

  private async switchAliasToNewIndex(newIndex: string, allias: string) {
    if (!this.opensearchClient) return;

    try {
      const current = await this.opensearchClient.cat.aliases({ name: allias, format: 'json' });
      const currentIndices = current.body.map((item: any) => item.index);

      const actions = [];

      for (const idx of currentIndices) {
        actions.push({ remove: { index: idx, alias: allias } });
      }

      actions.push({ add: { index: newIndex, alias: allias, is_write_index: true } });
      await this.opensearchClient.indices.updateAliases({ body: { actions } });
      this.logger.log(`Alias ${allias} switched to ${newIndex}`);
    } catch (error: any) {
      this.logger.error(`Failed to switch alias: ${error.message}`);
      throw error;
    }
  }

  private async getCurrentIndexName(pAlias: string): Promise<string> {
    if (!this.opensearchClient) {
      return null;
    }
    try {
      const response = await this.opensearchClient.indices.get({ index: `${pAlias}-*` }, { ignore: [404] });
      if (response && response.body && Object.keys(response.body).length > 0) {
        const indices = Object.entries(response.body)
          .map(([key]) => key)
          .sort((a, b) => {
            const versionA = parseInt(a.split('-').pop()?.slice(1) ?? '0');
            const versionB = parseInt(b.split('-').pop()?.slice(1) ?? '0');
            return versionA - versionB;
          }) as string[];

        return indices[indices.length - 1];
      }
    } catch (error) {
      this.logger.warn(`Alias ${pAlias} not found`);
    }

    return null;
  }

  private async getNextIndexName(pConfig: MigrationConfig): Promise<string> {
    const sourceIndex = await this.getCurrentIndexName(pConfig.alias);
    if (!sourceIndex) return pConfig.alias + '-v1';
    const lastIndexVersionString = sourceIndex.split('-').pop();
    const lastIndexVersion = parseInt(lastIndexVersionString?.slice(1) ?? '0');

    return `${pConfig.alias}-v${lastIndexVersion + 1}`;
  }

  private async validateMigration(migration: MigrationRecord, config: MigrationConfig): Promise<string | null> {
    const errors: string[] = [];

    if (migration.sourceIndex) {
      try {
        const [sourceRes, destRes] = await Promise.all([
          this.opensearchClient.count({ index: migration.sourceIndex }),
          this.opensearchClient.count({ index: migration.index }),
        ]);
        const sourceDocs = sourceRes.body.count as number;
        const destDocs = destRes.body.count as number;
        this.logger.log(`Doc count: ${migration.sourceIndex}=${sourceDocs}, ${migration.index}=${destDocs}`);
        if (destDocs < sourceDocs) {
          errors.push(`Doc count mismatch: source=${sourceDocs}, dest=${destDocs} (${sourceDocs - destDocs} missing)`);
        }
      } catch (error: any) {
        errors.push(`Count check failed: ${error.message}`);
      }
    }

    try {
      const mappingRes = await this.opensearchClient.indices.getMapping({ index: migration.index });
      const actualProps: Record<string, any> = mappingRes.body[migration.index]?.mappings?.properties ?? {};
      const expectedProps: Record<string, any> = config.values.mappings?.properties ?? {};
      const missingFields: string[] = [];
      const typeMismatches: string[] = [];
      for (const [field, def] of Object.entries(expectedProps)) {
        if (!actualProps[field]) {
          missingFields.push(field);
        } else if ((def as any).type && actualProps[field].type !== (def as any).type) {
          typeMismatches.push(`${field}: expected=${(def as any).type}, actual=${actualProps[field].type}`);
        }
      }
      this.logger.log(`Schema: ${Object.keys(actualProps).length} fields in index, ${Object.keys(expectedProps).length} expected`);
      if (missingFields.length > 0) errors.push(`Missing fields: ${missingFields.join(', ')}`);
      if (typeMismatches.length > 0) errors.push(`Type mismatch: ${typeMismatches.join('; ')}`);
    } catch (error: any) {
      errors.push(`Schema check failed: ${error.message}`);
    }

    return errors.length > 0 ? errors.join(' | ') : null;
  }
}
