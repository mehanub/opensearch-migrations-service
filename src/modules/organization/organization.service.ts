import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OpenSearchService } from '../opensearch-migration';
import { Organization, ORGANIZATION_ALIAS, EXAMPLE_ORGANIZATIONS } from './organization.interface';

@Injectable()
export class OrganizationService implements OnModuleInit {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(private readonly dualWrite: OpenSearchService) {}

  async onModuleInit() {
    await this.seedExamples();
  }

  async upsert(org: Organization): Promise<void> {
    await this.dualWrite.upsert({
      index: ORGANIZATION_ALIAS,
      id: org.uuid,
      body: org,
    });
    this.logger.log(`Upserted organization: ${org.uuid} (${org.name})`);
  }

  async delete(uuid: string): Promise<void> {
    await this.dualWrite.delete({
      index: ORGANIZATION_ALIAS,
      id: uuid,
    });
    this.logger.log(`Deleted organization: ${uuid}`);
  }

  private async seedExamples(): Promise<void> {
    this.logger.log('Seeding example organizations...');
    for (const org of EXAMPLE_ORGANIZATIONS) {
      await this.upsert(org);
    }
  }
}
