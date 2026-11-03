import { ConflictException } from '@nestjs/common';
import { MissingsProfile } from '../../entities/missings-profile.entity';
import { CodingJob } from '../../entities/coding-job.entity';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { CodingJobCoder } from '../../entities/coding-job-coder.entity';
import { ResponseEntity } from '../../entities/response.entity';
import FileUpload from '../../entities/file_upload.entity';
import { manualJobSnapshot, assertManualJobRevision } from './manual-job-snapshot.util';

describe('Atomic job revision', () => {
  function setup() {
    const job = {
      id: 1, workspace_id: 2, name: 'G8', status: 'completed', updated_at: new Date('2026-11-03T10:00:00Z')
    } as CodingJob;
    const units = [{
      id: 5, coding_job_id: 1, response_id: 7, unit_name: 'G8', variable_id: 'reason', code: 1, score: 2, notes: 'Geprüft', is_open: false
    }];
    const coders = [{ coding_job_id: 1, user_id: 9 }];
    const responses = [{
      id: 7, value: '20 m²', code_v1: null, code_v2: null
    }, {
      id: 99, value: '20 m²', code_v1: null, code_v2: null
    }];
    const files = [{
      id: 3, file_id: 'G8.VOCS', filename: 'G8.vocs', data: '{"score":2}'
    }];
    const reviewUnits = [{
      id: 26, coding_job_id: 12, response_id: 7, code: 1, score: 2
    }];
    const reviews = [{
      id: 12, workspace_id: 2, source_coding_job_id: 1, status: 'completed'
    }];
    const missingProfiles = [{ id: 4, workspace_id: 2, missings: '[]' }];
    const values = new Map<unknown, unknown[]>([[CodingJobUnit, units], [CodingJobCoder, coders], [ResponseEntity, responses], [FileUpload, files], [MissingsProfile, missingProfiles], [CodingJob, reviews]]);
    const manager = {
      getRepository: jest.fn(entity => ({
        find: jest.fn(async query => {
          if (entity === CodingJobUnit && typeof query.where.coding_job_id === 'object') return reviewUnits;
          if (entity === ResponseEntity && query.where.id) return responses.filter(response => query.where.id.value.includes(response.id));
          return values.get(entity) || [];
        })
      }))
    };
    return {
      job, units, coders, responses, files, missingProfiles, reviews, reviewUnits, manager
    };
  }
  it.each(['decision', 'answer', 'rubric', 'assignment', 'job', 'missing-profile', 'supervision', 'supervision-decision', 'aggregated-answer'] as const)('rejects changed %s even when a caller retains its approval', async changed => {
    const c = setup();
    const approved = await manualJobSnapshot(c.job, c.manager as never);
    if (changed === 'decision') c.units[0].score = 0;
    if (changed === 'aggregated-answer') c.responses[1].value = '21 m²';
    if (changed === 'answer') c.responses[0].value = '21 m²';
    if (changed === 'rubric') c.files[0].data = '{"score":3}';
    if (changed === 'assignment') c.coders[0].user_id = 10;
    if (changed === 'supervision-decision') c.reviewUnits[0].score = 0;
    if (changed === 'supervision') c.reviews[0].status = 'review';
    if (changed === 'missing-profile') c.missingProfiles[0].missings = '[{"score":0}]';
    if (changed === 'job') c.job.updated_at = new Date('2026-11-03T10:00:01Z');
    await expect(assertManualJobRevision(c.job, c.manager as never, approved.revision)).rejects.toThrow(ConflictException);
  });
  it('ignores loaded ORM relations while binding the same persisted job state', async () => {
    const c = setup();
    const approved = await manualJobSnapshot(c.job, c.manager as never);
    c.job.codingJobUnits = [];
    await expect(assertManualJobRevision(c.job, c.manager as never, approved.revision)).resolves.toBeUndefined();
  });
});
