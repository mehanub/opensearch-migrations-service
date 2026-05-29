import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppService } from './app.service';
import { OpenSearchMigrationModule } from './opensearch-migration/opensearch-migration.module';
import { OrganizationModule } from './organization/organization.module';
import { MigrationEntity } from './opensearch-migration/entites/migration.entity';
import { TypeOrmMigrationRepository } from './opensearch-migration/adapters/typeorm/typeorm-migration.repository';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || 'password',
      database: process.env.DB_DATABASE || 'migration_db',
      synchronize: true,
      autoLoadEntities: true,
    }),
    OpenSearchMigrationModule.forRootAsync({
      imports: [TypeOrmModule.forFeature([MigrationEntity])],
      useFactory: (repo: Repository<MigrationEntity>, dataSource: DataSource) => ({
        repository: new TypeOrmMigrationRepository(repo, dataSource),
        opensearchNode: process.env.OPENSEARCH_URL,
        opensearchUsername: process.env.OPENSEARCH_USERNAME,
        opensearchPassword: process.env.OPENSEARCH_PASSWORD,
        migrationsPath: './src/migrations/',
      }),
      inject: [getRepositoryToken(MigrationEntity), DataSource],
    }),
    OrganizationModule,
  ],
  providers: [AppService],
})
export class AppModule {}
