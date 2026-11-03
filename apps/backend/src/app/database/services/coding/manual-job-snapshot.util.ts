import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { EntityManager, ILike, In } from 'typeorm';
import { MissingsProfile } from '../../entities/missings-profile.entity';
import { CodingJob } from '../../entities/coding-job.entity';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { CodingJobCoder } from '../../entities/coding-job-coder.entity';
import { ResponseEntity } from '../../entities/response.entity';
import FileUpload from '../../entities/file_upload.entity';

/** Call only while holding the workspace and job mutation lock. */
export async function manualJobSnapshot(job: CodingJob, manager: EntityManager) {
  const units = await manager.getRepository(CodingJobUnit).find({ where: { coding_job_id: job.id }, order: { id: 'ASC' } });
  const coders = await manager.getRepository(CodingJobCoder).find({ where: { coding_job_id: job.id }, order: { user_id: 'ASC' } });
  // Native aggregation may propagate one representative decision to matching
  // responses outside the job-unit rows. Include that candidate population too.
  const unitNames = [...new Set(units.map(unit => unit.unit_name))];
  const variableIds = [...new Set(units.map(unit => unit.variable_id))];
  const responses: ResponseEntity[] = unitNames.length ? await manager.getRepository(ResponseEntity).find({
    where: { variableid: In(variableIds), unit: { name: In(unitNames), booklet: { person: { workspace_id: job.workspace_id } } } },
    order: { id: 'ASC' }
  }) : [];
  const files = await manager.getRepository(FileUpload).find({
    where: [{ workspace_id: job.workspace_id, filename: ILike('%.vocs') }, { workspace_id: job.workspace_id, file_type: 'Unit' }],
    select: ['id', 'file_id', 'filename', 'data'],
    order: { id: 'ASC' }
  });
  const missingProfiles = await manager.getRepository(MissingsProfile).find({ where: { workspace_id: job.workspace_id }, order: { id: 'ASC' } });
  // Applying a source job can use supervisor decisions even before its child job
  // is applied separately. Bind those decisions to the same approved revision.
  const reviewJobs = await manager.getRepository(CodingJob).find({ where: { source_coding_job_id: job.id, workspace_id: job.workspace_id }, order: { id: 'ASC' } });
  const reviewIds = reviewJobs.map(review => review.id);
  const reviewUnits = reviewIds.length ? await manager.getRepository(CodingJobUnit).find({ where: { coding_job_id: In(reviewIds) }, order: { id: 'ASC' } }) : [];
  const reviewState = reviewJobs.map(review => ({
    id: review.id, status: review.status, updated_at: review.updated_at, reviewer_user_id: review.reviewer_user_id, freshness_status: review.freshness_status
  }));
  // Hash native decisions, source responses and rubrics; do not return bulk answer data.
  const jobState = Object.fromEntries([
    'job_type', 'source_coding_job_id', 'reviewer_user_id', 'id', 'workspace_id', 'name', 'description', 'status', 'comment', 'updated_at', 'creatorUserId',
    'missings_profile_id', 'job_definition_id', 'training_id', 'allowComments', 'showScore',
    'aggregation_enabled', 'aggregation_threshold', 'response_matching_flags', 'aggregation_settings_version',
    'freshness_status', 'freshness_reason', 'freshness_updated_at'
  ].map(key => [key, job[key as keyof CodingJob]]));
  const revision = createHash('sha256').update(JSON.stringify({
    job: jobState, units, coders, responses, files, missingProfiles, reviewState, reviewUnits
  })).digest('hex');
  return {
    id: job.id,
    workspace_id: job.workspace_id,
    name: job.name,
    status: job.status,
    freshnessStatus: job.freshness_status || 'current',
    assigned_coders: coders.map(coder => coder.user_id),
    revision,
    cases: units.length,
    coded: units.filter(unit => unit.code !== null).length,
    open: units.filter(unit => unit.is_open).length,
    requires_review: units.some(unit => [-1, -2].includes(unit.code) || [-1, -2].includes(unit.coding_issue_option)),
    rubric_files: files.length
  };
}

export async function assertManualJobRevision(job: CodingJob, manager: EntityManager, expectedRevision?: string) {
  if (expectedRevision && (await manualJobSnapshot(job, manager)).revision !== expectedRevision) {
    throw new ConflictException('Coding job, source answers, assignments or rubrics changed; reload and approve again');
  }
}
