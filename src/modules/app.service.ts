import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {OpenSearchMigrationService}  from './opensearch-migration/opensearch-migration.service';

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly migrationService: OpenSearchMigrationService) {}

  async onModuleInit() {

  }

  getHello(): string {
    return 'OpenSearch Migration Service is running!';
  }
}