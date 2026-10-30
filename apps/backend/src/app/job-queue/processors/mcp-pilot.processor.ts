import { Process, Processor } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Job } from 'bull';
import { McpPilotOperationService } from '../../database/services/jobs/mcp-pilot-operation.service';
import { McpPilotJobData } from '../job-queue.service';

@Injectable()
@Processor('mcp-pilot')
export class McpPilotProcessor {
  constructor(private readonly operations: McpPilotOperationService) {}

  @Process({ concurrency: 2 })
  async process(job: Job<McpPilotJobData>): Promise<void> {
    // Only operation metadata enters Redis. Credentials stay out of Bull.
    await this.operations.execute(job.data.operationId);
  }
}
