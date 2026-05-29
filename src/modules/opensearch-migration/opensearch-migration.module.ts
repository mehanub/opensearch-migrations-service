import { Module, DynamicModule, Provider, OnModuleDestroy } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Client } from '@opensearch-project/opensearch';
import { OpenSearchMigrationService } from './opensearch-migration.service';
import { OpenSearchService } from './opensearch.service';
import { IMigrationRepository } from './interfaces/migration-repository.interface';

export interface OpenSearchMigrationModuleOptions {
  migrationsPath?: string;
  opensearchNode?: string;
  opensearchUsername?: string;
  opensearchPassword?: string;
  aliasName?: string;
  repository: IMigrationRepository;
}

export interface OpenSearchMigrationModuleAsyncOptions {
  imports?: any[];
  useFactory: (...args: any[]) => Promise<OpenSearchMigrationModuleOptions> | OpenSearchMigrationModuleOptions;
  inject?: any[];
}

@Module({})
export class OpenSearchMigrationModule implements OnModuleDestroy {
  private static client: Client | null = null;

  static forRoot(options: OpenSearchMigrationModuleOptions): DynamicModule {
    const opensearchClientProvider: Provider = {
      provide: 'OPENSEARCH_CLIENT',
      useFactory: () => {
        const node = options.opensearchNode || process.env.OPENSEARCH_URL || 'http://localhost:9200';
        const username = options.opensearchUsername || process.env.OPENSEARCH_USERNAME || 'admin';
        const password = options.opensearchPassword || process.env.OPENSEARCH_PASSWORD || 'admin';
        this.client = new Client({ node, auth: { username, password } });
        return this.client;
      },
    };

    const migrationsPathProvider: Provider = {
      provide: 'MIGRATIONS_PATH',
      useValue: options.migrationsPath || process.env.MIGRATIONS_PATH || './src/migrations/opensearch',
    };

    const repositoryProvider: Provider = {
      provide: 'MIGRATION_REPOSITORY',
      useValue: options.repository,
    };

    return {
      global: true,
      module: OpenSearchMigrationModule,
      imports: [ScheduleModule.forRoot()],
      providers: [opensearchClientProvider, migrationsPathProvider, repositoryProvider, OpenSearchMigrationService, OpenSearchService],
      exports: [OpenSearchMigrationService, OpenSearchService],
    };
  }

  static forRootAsync(asyncOptions: OpenSearchMigrationModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: 'OPENSEARCH_MIGRATION_OPTIONS',
      useFactory: asyncOptions.useFactory,
      inject: asyncOptions.inject || [],
    };

    const opensearchClientProvider: Provider = {
      provide: 'OPENSEARCH_CLIENT',
      useFactory: (options: OpenSearchMigrationModuleOptions) => {
        const node = options.opensearchNode || process.env.OPENSEARCH_URL || 'http://localhost:9200';
        const username = options.opensearchUsername || process.env.OPENSEARCH_USERNAME || 'admin';
        const password = options.opensearchPassword || process.env.OPENSEARCH_PASSWORD || 'admin';
        OpenSearchMigrationModule.client = new Client({ node, auth: { username, password } });
        return OpenSearchMigrationModule.client;
      },
      inject: ['OPENSEARCH_MIGRATION_OPTIONS'],
    };

    const migrationsPathProvider: Provider = {
      provide: 'MIGRATIONS_PATH',
      useFactory: (options: OpenSearchMigrationModuleOptions) =>
        options.migrationsPath || process.env.MIGRATIONS_PATH || './src/migrations/opensearch',
      inject: ['OPENSEARCH_MIGRATION_OPTIONS'],
    };

    const repositoryProvider: Provider = {
      provide: 'MIGRATION_REPOSITORY',
      useFactory: (options: OpenSearchMigrationModuleOptions) => options.repository,
      inject: ['OPENSEARCH_MIGRATION_OPTIONS'],
    };

    return {
      global: true,
      module: OpenSearchMigrationModule,
      imports: [ScheduleModule.forRoot(), ...(asyncOptions.imports || [])],
      providers: [optionsProvider, opensearchClientProvider, migrationsPathProvider, repositoryProvider, OpenSearchMigrationService, OpenSearchService],
      exports: [OpenSearchMigrationService, OpenSearchService],
    };
  }

  async onModuleDestroy() {
    if (OpenSearchMigrationModule.client) {
      await OpenSearchMigrationModule.client.close();
    }
  }
}
