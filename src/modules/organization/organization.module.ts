import { Module } from '@nestjs/common';
import { OrganizationService } from './organization.service';

// OpenSearchService is provided by OpenSearchMigrationModule imported in AppModule
@Module({
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
