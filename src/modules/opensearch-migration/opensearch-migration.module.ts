import { Module, DynamicModule, Provider, OnModuleDestroy } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Client } from '@opensearch-project/opensearch';
import { MigrationEntity } from './entites/migration.entity';
import { OpenSearchMigrationService } from './opensearch-migration.service';

export interface OpenSearchMigrationModuleOptions {
  migrationsPath?: string;
  opensearchNode?: string;
  opensearchUsername?: string;
  opensearchPassword?: string;
  aliasName?: string;
}

@Module({})
export class OpenSearchMigrationModule implements OnModuleDestroy {
  private static client: Client | null = null;

  static forRoot(options: OpenSearchMigrationModuleOptions = {}): DynamicModule {
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

    return {
      module: OpenSearchMigrationModule,
      imports: [TypeOrmModule.forFeature([MigrationEntity]), ScheduleModule.forRoot()],
      providers: [opensearchClientProvider, migrationsPathProvider, OpenSearchMigrationService],
      exports: [OpenSearchMigrationService],
    };
  }

  async onModuleDestroy() {
    if (OpenSearchMigrationModule.client) {
      await OpenSearchMigrationModule.client.close();
    }
  }
}