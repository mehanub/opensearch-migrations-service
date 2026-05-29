import { Injectable, Logger, Inject } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';

export interface DualWriteTarget {
  sourceIndex: string;
  destIndex: string;
}

@Injectable()
export class OpenSearchService {
  private readonly logger = new Logger(OpenSearchService.name);
  private targets: Map<string, DualWriteTarget> = new Map();

  constructor(
    @Inject('OPENSEARCH_CLIENT') private readonly opensearchClient: Client,
  ) {}

  setTargets(targets: Map<string, DualWriteTarget>): void {
    this.targets = new Map(targets);
    if (targets.size > 0) {
      this.logger.log(`Dual-write enabled for: ${[...targets.keys()].join(', ')}`);
    } else {
      this.logger.log('Dual-write disabled');
    }
  }

  private getWriteIndices(indexOrAlias: string): string[] {
    const target = this.targets.get(indexOrAlias);
    if (!target) return [indexOrAlias];
    return [target.sourceIndex, target.destIndex];
  }

  // Runs operation on all targets in parallel.
  // Secondary failures are logged but do not throw — primary result is always returned.
  private async fanOut<T>(
    indices: string[],
    operation: (index: string) => Promise<T>,
  ): Promise<T> {
    if (indices.length === 1) return operation(indices[0]);

    const results = await Promise.allSettled(indices.map(idx => operation(idx)));

    results.slice(1).forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.warn(
          `Dual-write to secondary "${indices[i + 1]}" failed: ${r.reason?.message ?? r.reason}`,
        );
      }
    });

    const primary = results[0];
    if (primary.status === 'rejected') throw primary.reason;
    return primary.value;
  }

  /**
   * Upsert a document by ID into the alias (and secondary index if dual-write is active).
   * Uses opensearchClient.index() which creates or fully replaces the document.
   */
  async upsert(params: Parameters<Client['index']>[0]): Promise<any> {
    const indices = this.getWriteIndices(params.index as string);
    return this.fanOut(indices, idx => this.opensearchClient.index({ ...params, index: idx }));
  }

  /**
   * Delete a document by ID from the alias (and secondary index if dual-write is active).
   * 404 on secondary is silently ignored — the document may not be reindexed yet.
   */
  async delete(params: Parameters<Client['delete']>[0]): Promise<any> {
    const indices = this.getWriteIndices(params.index as string);
    if (indices.length === 1) return this.opensearchClient.delete(params);

    const [primary, ...secondaries] = indices;
    const primaryResult = await this.opensearchClient.delete({ ...params, index: primary });

    Promise.allSettled(
      secondaries.map(idx =>
        this.opensearchClient.delete({ ...params, index: idx }, { ignore: [404] }),
      ),
    ).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(
            `Dual-write secondary delete to "${secondaries[i]}" failed: ${r.reason?.message ?? r.reason}`,
          );
        }
      });
    });

    return primaryResult;
  }

  get client(): Client {
    return this.opensearchClient;
  }
}
