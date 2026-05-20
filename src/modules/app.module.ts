import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppService } from './app.service';
import { OpenSearchMigrationModule } from './opensearch-migration/opensearch-migration.module';

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
    OpenSearchMigrationModule.forRoot({
      migrationsPath: './src/migrations/',
      opensearchNode: process.env.OPENSEARCH_URL,
      opensearchUsername: process.env.OPENSEARCH_USERNAME,
      opensearchPassword: process.env.OPENSEARCH_PASSWORD
    }),
  ],
  providers: [AppService],
})
export class AppModule {}