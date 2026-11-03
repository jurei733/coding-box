import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { CodingJob } from '../../entities/coding-job.entity';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { ResponseEntity } from '../../entities/response.entity';
import type { CodingJobSchemeService } from './coding-job-scheme.service';
import { formatCodingTestPersonFromUnit } from './coding-progress-key.util';

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
