import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { MissingsProfile } from '../../entities/missings-profile.entity';
import { ResponseEntity } from '../../entities/response.entity';
import FileUpload from '../../entities/file_upload.entity';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { CodingJob } from '../../entities/coding-job.entity';
import { statusStringToNumber } from '../../utils/response-status-converter';
import { lockWorkspaceTestResultsMutationInTransaction, withWorkspaceTestResultsMutationTransaction } from '../shared/workspace-test-results-lock.util';

export async function finalizationSnapshot(manager: EntityManager, workspace: number, groups: string[]) {
  const rows = await manager.getRepository(ResponseEntity).createQueryBuilder('response')
    .innerJoin('response.unit', 'unit').innerJoin('unit.booklet', 'booklet')
    .innerJoin('booklet.person', 'person')
    .where('person.workspace_id = :workspace AND person.consider = true', { workspace })
    .andWhere('person.group IN (:...groups)', { groups })
    .orderBy('response.id', 'ASC')
    .getMany();
  const jobs = await manager.getRepository(CodingJob).createQueryBuilder('job')
    .innerJoin(CodingJobUnit, 'case', 'case.coding_job_id = job.id')
    .innerJoin(ResponseEntity, 'response', 'response.id = case.response_id')
    .innerJoin('response.unit', 'unit')
    .innerJoin('unit.booklet', 'booklet')
    .innerJoin('booklet.person', 'person')
    .where('job.workspace_id = :workspace AND person.group IN (:...groups)', { workspace, groups })
    .andWhere('job.status != :applied', { applied: 'results_applied' })
    .orderBy('job.id', 'ASC')
    .getMany();
  const schemes = await manager.getRepository(FileUpload).createQueryBuilder('file')
    .where('file.workspace_id = :workspace', { workspace }).andWhere("(LOWER(file.filename) LIKE '%.vocs' OR file.file_type = 'Unit')")
    .orderBy('file.id', 'ASC')
    .getMany();
  const missingProfiles = await manager.getRepository(MissingsProfile).find({ where: { workspace_id: workspace }, order: { id: 'ASC' } });
  const incomplete = statusStringToNumber('CODING_INCOMPLETE'); const
    complete = statusStringToNumber('CODING_COMPLETE');
  const unresolved = rows.filter(row => row.status_v1 === incomplete && row.status_v2 !== complete).length;
  const source = rows.map(row => ({
    ...row, status_v3: undefined, code_v3: undefined, score_v3: undefined
  }));
  const revision = createHash('sha256').update(JSON.stringify({
    source, schemes, jobs, missingProfiles, groups: [...groups].sort()
  })).digest('hex');
  return {
    workspace_id: workspace,
    group_ids: [...groups].sort(),
    revision,
    responses: rows.length,
    unresolved_manual_responses: unresolved,
    pending_jobs: jobs.map(job => ({ id: job.id, name: job.name, status: job.status })),
    eligible: rows.length > 0 && unresolved === 0 && jobs.length === 0,
    final_responses: rows.filter(row => row.status_v3 !== null).length,
    result_version: 'v3'
  };
}

export function readFinalizationSnapshot(connection: DataSource, workspace: number, groups: string[]) {
  return withWorkspaceTestResultsMutationTransaction(connection, async manager => {
    await lockWorkspaceTestResultsMutationInTransaction(manager, workspace);
    return finalizationSnapshot(manager, workspace, groups);
  });
}
