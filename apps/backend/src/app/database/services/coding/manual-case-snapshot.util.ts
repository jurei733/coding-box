import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { CodingJob } from '../../entities/coding-job.entity';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { ResponseEntity } from '../../entities/response.entity';
import type { CodingJobSchemeService } from './coding-job-scheme.service';
import { formatCodingTestPersonFromUnit } from './coding-progress-key.util';
import { CODING_JOB_TYPE_CODING_ISSUE_REVIEW } from './coding-job-type.util';

/** Read under the job mutation lock, shared by the preview and progress write. */
export async function manualCaseSnapshot(
  job: CodingJob,
  unit: CodingJobUnit,
  manager: EntityManager,
  schemes: CodingJobSchemeService
) {
  const response = await manager.getRepository(ResponseEntity).findOne({
    where: { id: unit.response_id },
    relations: ['unit', 'unit.booklet', 'unit.booklet.person']
  });
  if (!response || response.unit?.booklet?.person?.workspace_id !== job.workspace_id) {
    throw new NotFoundException('Manual response not found in this workspace');
  }
  const allSchemes = await schemes.getCodingSchemesForUnits([unit], job.workspace_id, manager);
  const scheme = allSchemes.get(unit);
  const variable = scheme ? schemes.findVariableCoding(scheme, unit.variable_id) : undefined;
  if (!variable) throw new ConflictException('Manual coding scheme unavailable');
  const snapshot = {
    workspace_id: job.workspace_id,
    job_id: job.id,
    job_status: job.status,
    job_freshness: job.freshness_status || 'current',
    response_id: response.id,
    test_person: formatCodingTestPersonFromUnit(unit),
    unit_name: unit.unit_name,
    variable_id: unit.variable_id,
    value: response.value,
    subform: response.subform,
    applied: { status: response.status_v2, code: response.code_v2, score: response.score_v2 },
    final: { status: response.status_v3, code: response.code_v3, score: response.score_v3 },
    automatic: { status: response.status_v1, code: response.code_v1, score: response.score_v1 },
    manual: {
      code: unit.code, score: unit.score, is_open: unit.is_open, notes: unit.notes ?? '', coding_issue_option: unit.coding_issue_option ?? null
    },
    rubric: variable
  };
  const revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { ...snapshot, revision };
}

export async function reviewCaseSnapshot(job: CodingJob, unit: CodingJobUnit, manager: EntityManager, schemes: CodingJobSchemeService, reviewerId: number) {
  const source = await manualCaseSnapshot(job, unit, manager, schemes);
  const reviewJob = await manager.getRepository(CodingJob).findOne({
    where: { source_coding_job_id: job.id, reviewer_user_id: reviewerId, job_type: CODING_JOB_TYPE_CODING_ISSUE_REVIEW }
  });
  const decision = reviewJob ? await manager.getRepository(CodingJobUnit).findOne({ where: { coding_job_id: reviewJob.id, response_id: unit.response_id } }) : null;
  const review = {
    job_id: reviewJob?.id ?? null,
    status: reviewJob?.status ?? null,
    reviewer_id: reviewerId,
    code: decision?.code ?? null,
    score: decision?.score ?? null,
    notes: decision?.notes ?? '',
    is_open: decision?.is_open ?? false
  };
  return { ...source, review, revision: createHash('sha256').update(JSON.stringify({ source, review })).digest('hex') };
}
