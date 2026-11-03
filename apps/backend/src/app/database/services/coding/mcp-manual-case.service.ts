import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { CodingJobAccessService } from './coding-job-access.service';
import { CodingJobMutationService } from './coding-job-mutation.service';
import { CodingJobSchemeService } from './coding-job-scheme.service';
import { manualCaseSnapshot } from './manual-case-snapshot.util';

@Injectable()
export class McpManualCaseService {
  constructor(
    private readonly mutation: CodingJobMutationService,
    private readonly access: CodingJobAccessService,
    private readonly schemes: CodingJobSchemeService
  ) {}

  async get(workspaceId: number, jobId: number, responseId: number, actorId: number) {
    return this.mutation.withLockedCodingJob(jobId, workspaceId, async (job, manager) => {
      if (job.workspace_id !== workspaceId) throw new NotFoundException('Coding job not found');
      await this.access.assertAssignedCoderAccess(jobId, workspaceId, actorId, manager);
      const units = await manager.getRepository(CodingJobUnit).find({
        where: { coding_job_id: jobId, response_id: responseId }
      });
      if (units.length !== 1) throw new ConflictException('A unique assigned manual case is required');
      return manualCaseSnapshot(job, units[0], manager, this.schemes);
    });
  }
}
