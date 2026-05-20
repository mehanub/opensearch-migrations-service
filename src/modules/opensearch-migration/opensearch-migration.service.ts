import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Client } from '@opensearch-project/opensearch';
import { MigrationEntity } from './entites/migration.entity';
import { MigrationConfig } from './interfaces/migration.interface';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class OpenSearchMigrationService implements OnModuleInit {
  private readonly logger = new Logger(OpenSearchMigrationService.name);
  private migrations: Map<string, MigrationConfig> = new Map();
  private migrationsPath: string;
  private activeTaskIds: Set<string> = new Set();
  private readonly aliasName: string;
  private isProcessing = false;

  constructor(
    @InjectRepository(MigrationEntity)
    private readonly migrationRepo: Repository<MigrationEntity>,
    @Inject('OPENSEARCH_CLIENT')
    private readonly opensearchClient?: Client,
    @Optional() @Inject('MIGRATIONS_PATH') customPath?: string,
  ) {
    this.migrationsPath = customPath || process.env.MIGRATIONS_PATH || './src/migrations/opensearch';
  }

  async onModuleInit() {
    await this.ensureMigrationTableExists();
    await this.loadMigrationsFromDirectory();
    await this.resumePendingMigrations();
    await this.runPendingMigrations();

    this.logger.log(`OpenSearch Migration Service initialized. Loaded ${this.migrations.size} migrations`);
  }

  private async ensureMigrationTableExists() {
    try {
      await this.migrationRepo.query(`
        CREATE TABLE IF NOT EXISTS opensearch_migrations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          migration_name VARCHAR(255) NOT NULL,
          type VARCHAR(50) NOT NULL,
          version VARCHAR(50),
          index VARCHAR(255) NOT NULL,
          alias VARCHAR(255) NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          task_id VARCHAR(255),
          error_message TEXT,
          metadata JSONB,
          started_by VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          started_at TIMESTAMP,
          completed_at TIMESTAMP
        );
      `);

      this.logger.log('Migration table ensured');
    } catch (error) {
      this.logger.warn(`Migration table creation: ${error}`);
    }
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

      } catch (error ) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed: ${errorMessage}`);
      }
    }
  }W

  private async resumePendingMigrations() {
    const pending = await this.migrationRepo.find({
      where: [{ status: 'in_progress' }, { status: 'pending' }],
    });

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
      const completedMigrations = await this.migrationRepo.find({
        where: { status: 'completed' },
      });

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

        const alreadyStarted = await this.migrationRepo.findOne({
          where: { migrationName, status: In(['pending', 'in_progress']) },
        });

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

    const migration = this.migrationRepo.create({
      migrationName,
      type: config.type,
      version: config.version,
      index: config.index,
      alias: config.alias,
      status: 'pending',
      startedBy,
      metadata: config
    });

    await this.migrationRepo.save(migration);
    this.logger.log(`Created migration record: ${migrationName} (${migration.id})`);


    const migrationRecord = await this.migrationRepo.findOne({ where: { id: migration.id } });
    if (!migrationRecord) return;

    switch (config.type) {
			case 'create':
				await this.executeCreateScheme(migration.id, config);
				break;
			case 'migrate':
				await this.executeMigrateScheme(migration.id, config);
				break;
			default:
				this.logger.error(`Definition type ${config.type} not supported`);
				process.exit(1);
		}
  }


  async executeMigrateScheme(migrationId: string, config: MigrationConfig){
    try {
      await this.migrationRepo.update(migrationId, {
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
		  const newIndexName = `${config.index}-v${lastIndexVersion + 1}`;

      this.logger.log(`Creating index: ${newIndexName}`);
      await this.opensearchClient.indices.create({
        index: newIndexName,
        body: {
          mappings: config.values.mappings,
        },
      });

      this.logger.log(`Starting reindex from ${sourceIndex} to ${newIndexName}`);

      const reindexBody: any = {
        conflicts: 'proceed',
        source: { index: sourceIndex },
        dest: { index: newIndexName, op_type: 'create' },
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

      await this.migrationRepo.update(migrationId, {
        taskId
      });

      this.activeTaskIds.add(taskId);
      this.logger.log(`Reindex started: ${taskId}`);
    } catch (error) {
      await this.migrationRepo.update(migrationId, {
        status: 'failed',
        errorMessage: 'error',
        completedAt: new Date()
      });
      throw error;
    }
  }

  async executeCreateScheme(migrationId: string, config: MigrationConfig){
    const newIndex = config.index + '-v1';
     if (!this.opensearchClient) {
      throw new Error('OpenSearch client not available');
    }

    const migrationRecord = await this.migrationRepo.findOne({ where: { id: migrationId } });
    if (!migrationRecord) return;

    try {
      await this.migrationRepo.update(migrationId, {
        status: 'in_progress',
        startedAt: new Date(),
      });
      const response = await this.opensearchClient.indices.get({ index: `${newIndex}` }, { ignore: [404] });
      if (response.statusCode === 200) {
        this.logger.log(`Index ${newIndex} already exists, skipping...`);
        return;
      }

		// Check if alias already exists
		const aliasResponse = await this.opensearchClient.indices.getAlias({ name: config.alias }, { ignore: [404] });
		if (aliasResponse.statusCode === 200) {
			this.logger.log(`Alias ${config.alias} already exists, skipping...`);
			return;
		}

      this.logger.log(`Creating index: ${newIndex}`);
      await this.opensearchClient.indices.create({
        index: newIndex,
        body: {
          mappings: config.values.mappings,
        },
      });

		// Create alias pointing to the versioned index
		await this.opensearchClient.indices.putAlias({ index: `${newIndex}`, name: `${config.alias}` });

    await this.migrationRepo.update(migrationRecord.id, {
          status: 'completed', 
          completedAt: new Date() 
    }); 
    } catch (error) {
      await this.migrationRepo.update(migrationId, {
        status: 'failed',
        errorMessage: 'error',
        completedAt: new Date()
      });
      throw error;
    }
  }


  @Cron(CronExpression.EVERY_5_SECONDS)
  async checkActiveMigrations() {
    if (this.activeTaskIds.size === 0) return;

    const activeMigrations = await this.migrationRepo.find({
      where: { status: 'in_progress', type: 'migrate'},
    });

    for (const migration of activeMigrations) {
      if (!migration.taskId || !this.opensearchClient) continue;

      try {
        const status = await this.opensearchClient.tasks.get({ task_id: migration.taskId });

        if (status.body.completed) {
          const response = status.body.response;

          const config = this.migrations.get(migration.migrationName);
          let validationError: string | null = null;

         // validationError = await this.validateMigration(migration.index, config);

          await this.migrationRepo.update(migration.id, {
            status: validationError ? 'failed' : 'completed',
            totalDocs: response.total,
            createdDocs: response.created,
            completedAt: new Date(),
            errorMessage: validationError,
          });

          if (!validationError) {
            await this.switchAliasToNewIndex(migration.index, migration.alias);
            this.logger.log(`✅ Migration ${migration.migrationName} completed! (${response.created} docs created)`);
          } else {
            this.logger.error(`❌ Migration ${migration.migrationName} validation failed: ${validationError}`);
          }

          this.activeTaskIds.delete(migration.taskId);
        } else if (status.body.error) {
          await this.migrationRepo.update(migration.id, {
            status: 'failed',
            errorMessage: status.body.error.reason,
            completedAt: new Date(),
          });
          this.activeTaskIds.delete(migration.taskId);
          this.logger.error(`❌ Migration ${migration.migrationName} failed: ${status.body.error.reason}`);
        }
      } catch (error: any) {
        if (error.statusCode === 404) {
          this.logger.warn(`Task ${migration.taskId} not found`);
          await this.migrationRepo.update(migration.id, {
            status: 'failed',
            errorMessage: `Task not found: ${error.message}`,
            completedAt: new Date(),
          });
          this.activeTaskIds.delete(migration.taskId);
        }
      }
    }
  }

  private async validateMigration(indexName: string, config: MigrationConfig): Promise<string | null> {
    if (!this.opensearchClient) return null;

    try {
      const count = await this.opensearchClient.count({ index: indexName });
      if (count.body.count === 0) {
        return 'Validation failed: index is empty';
      }
      return null;
    } catch (error: any) {
      return `Validation error: ${error.message}`;
    }
  }

  private async switchAliasToNewIndex(newIndex: string, allias: string) {
    if (!this.opensearchClient) return;

    try {
      const current = await this.opensearchClient.cat.aliases({ name: allias, format: 'json' });
      const currentIndices = current.body.map((item: any) => item.index);

      const actions = [];

      for (const idx of currentIndices) {
        actions.push({ remove: { index: idx, alias: this.aliasName } });
      }

      actions.push({ add: { index: newIndex, alias: allias, is_write_index: true } });

      await this.opensearchClient.indices.updateAliases({ body: { actions } });
      this.logger.log(`Alias ${this.aliasName} switched to ${newIndex}`);
    } catch (error: any) {
      this.logger.error(`Failed to switch alias: ${error.message}`);
      throw error;
    }
  }


  private async getCurrentIndexName(pAlias: string): Promise<string> {
    if (!this.opensearchClient) {
      return `${process.env.OPENSEARCH_INDEX_PREFIX || 'app'}-1.0.0`;
    }

    try {
      const response = await this.opensearchClient.cat.aliases({ name: pAlias, format: 'json' });
      if (response.body && response.body.length > 0) {
        return response.body[0].index;
      }
    } catch (error) {
      this.logger.warn(`Alias ${this.aliasName} not found`);
    }

    return `${process.env.OPENSEARCH_INDEX_PREFIX || 'app'}-1.0.0`;
  }

}