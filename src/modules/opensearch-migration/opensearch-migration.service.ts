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
    const nextIndexName = await this.getNextIndexName(config);

    const migration = this.migrationRepo.create({
      migrationName,
      type: config.type,
      version: config.version,
      index: nextIndexName,
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


  async executeMigrateScheme(migration: MigrationEntity, config: MigrationConfig){
    try {
      await this.migrationRepo.update(migration.id, {
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

      await this.migrationRepo.update(migration.id, {
        taskId
      });

      this.activeTaskIds.add(taskId);
      this.logger.log(`Reindex started: ${taskId}`);
    } catch (error) {
      
      await this.migrationRepo.update(migration.id, {
        status: 'failed',
        errorMessage: 'error',
        completedAt: new Date()
      });
      process.exit(1);
    }
  }

  async executeCreateScheme(migration: MigrationEntity, config: MigrationConfig){

    if (!this.opensearchClient) {
      throw new Error('OpenSearch client not available');
    }

    try {
      await this.migrationRepo.update(migration.id, {
        status: 'in_progress',
        startedAt: new Date(),
      });
      const response = await this.opensearchClient.indices.get({ index: `${migration.index}` }, { ignore: [404] });
      if (response.statusCode === 200) {
        this.logger.log(`Index ${migration.index} already exists, skipping...`);
         throw (`Index ${migration.index} already exists, skipping...`)
      }

		// Check if alias already exists
		const aliasResponse = await this.opensearchClient.indices.getAlias({ name: config.alias }, { ignore: [404] });
		if (aliasResponse.statusCode === 200) {
			  throw (`Index ${migration.index} already exists, skipping...`)
		}

      this.logger.log(`Creating index: ${migration.index}`);
      await this.opensearchClient.indices.create({
        index: migration.index,
        body: {
          mappings: config.values.mappings,
        },
      });

		// Create alias pointing to the versioned index
		await this.opensearchClient.indices.putAlias({ index: `${migration.index}`, name: `${config.alias}` });

    await this.migrationRepo.update(migration.id, {
          status: 'completed', 
          completedAt: new Date() 
    }); 
    } catch (error) {
      await this.migrationRepo.update(migration.id, {
        status: 'failed',
        errorMessage: 'error',
        completedAt: new Date()
      });
      process.exit(1);
    }
  }


  @Cron(CronExpression.EVERY_MINUTE)
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
         // validationError = await this.validateMigration(migration.index, config);

          await this.switchAliasToNewIndex(migration.index, migration.alias);
          this.logger.log(`✅ Migration ${migration.migrationName} completed! (${response.created} docs created)`);

          this.activeTaskIds.delete(migration.taskId);

           await this.migrationRepo.update(migration.id, {
            status:  'completed',
            totalDocs: response.total,
            createdDocs: response.created,
            completedAt: new Date()
          });
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
        // Get last index version
        const indices = Object.entries(response.body)
          .map(([key]) => key)
          .sort((a, b) => {
            // Extract version numbers for proper numeric sorting
            const versionA = parseInt(a.split('-').pop()?.slice(1) ?? '0');
            const versionB = parseInt(b.split('-').pop()?.slice(1) ?? '0');
            return versionA - versionB;
          }) as string[];

        return indices[indices.length - 1];
      }
    } catch (error) {
      this.logger.warn(`Alias ${pAlias} not found`);
    }

    return  null;
  }

  private async getNextIndexName(pConfig: MigrationConfig): Promise<string>{
     const sourceIndex = await this.getCurrentIndexName(pConfig.alias);
     if (!sourceIndex) return  pConfig.alias + '-v1';
    const lastIndexVersionString = sourceIndex.split('-').pop();
    const lastIndexVersion = parseInt(lastIndexVersionString?.slice(1) ?? '0');
    
    return  `${pConfig.alias}-v${lastIndexVersion + 1}`;

  }

}