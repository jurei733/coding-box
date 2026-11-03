import {
  ConflictException, Injectable, NotFoundException, Optional
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { readFinalizationSnapshot } from './mcp-finalization-snapshot.util';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { CodingJobAccessService } from './coding-job-access.service';
import { CodingJobMutationService } from './coding-job-mutation.service';
import { CodingJobSchemeService } from './coding-job-scheme.service';
import { manualCaseSnapshot, reviewCaseSnapshot } from './manual-case-snapshot.util';
import { manualJobSnapshot } from './manual-job-snapshot.util';

@Injectable()
export class McpManualCaseService {
  constructor(
    private readonly mutation: CodingJobMutationService,
    private readonly access: CodingJobAccessService,
    private readonly schemes: CodingJobSchemeService,
    @Optional() private readonly connection?: DataSource
  ) {}

  finalization(workspace: number, groups: string[]) {
    if (!this.connection) throw new ConflictException('Database connection unavailable');
    return readFinalizationSnapshot(this.connection, workspace, groups);
  }

  async state(workspaceId: number, jobId: number, actorId: number, administrator = false) {
    return this.mutation.withLockedCodingJob(jobId, workspaceId, async (job, manager) => {
      if (!administrator) await this.access.assertAssignedCoderAccess(jobId, workspaceId, actorId, manager);
      return manualJobSnapshot(job, manager);
    });
  }

  async reviews(workspace: number, jobId: number, page: number, limit: number) {
    return this.mutation.withLockedCodingJob(jobId, workspace, async (_job, manager) => {
      const [units, total] = await manager.getRepository(CodingJobUnit).findAndCount({
        where: [{ coding_job_id: jobId, code: In([-1, -2]) }, { coding_job_id: jobId, coding_issue_option: In([-1, -2]) }],
        order: { id: 'ASC' },
        skip: (page - 1) * limit,
        take: limit
      });
      return {
        cases: units.map(unit => ({
          response_id: unit.response_id, unit_name: unit.unit_name, variable_id: unit.variable_id, code: unit.code, is_open: unit.is_open
        })),
        total,
        page,
        limit
      };
    });
  }

  async review(workspace: number, jobId: number, responseId: number, reviewerId: number) {
    return this.mutation.withLockedCodingJob(jobId, workspace, async (job, manager) => {
      const units = await manager.getRepository(CodingJobUnit).find({ where: { coding_job_id: jobId, response_id: responseId } });
      if (units.length !== 1) throw new ConflictException('Unique source case required');
      return reviewCaseSnapshot(job, units[0], manager, this.schemes, reviewerId);
    });
  }

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
