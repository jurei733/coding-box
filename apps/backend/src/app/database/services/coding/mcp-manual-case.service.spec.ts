import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CodingJob } from '../../entities/coding-job.entity';
import { CodingJobUnit } from '../../entities/coding-job-unit.entity';
import { ResponseEntity } from '../../entities/response.entity';
import { McpManualCaseService } from './mcp-manual-case.service';
import { CodingJobProgressService } from './coding-job-progress.service';
import { manualCaseSnapshot } from './manual-case-snapshot.util';

describe('MCP manual case and atomic progress', () => {
  function setup() {
    const job = {
      id: 3, workspace_id: 12, status: 'active', allowComments: true
    } as CodingJob;
    const unit = {
      id: 7,
      coding_job_id: 3,
      response_id: 18,
      unit_name: 'G8-05',
      variable_id: 'reason',
      person_login: 'pilot',
      person_code: 'p1',
      person_group: 'G8',
      booklet_name: 'B1',
      code: null,
      score: null,
      notes: '',
      is_open: false,
      coding_issue_option: null
    } as CodingJobUnit;
    const response = {
      id: 18, value: '20 m², weil ...', subform: '', unit: { booklet: { person: { workspace_id: 12 } } }
    };
    const rubric = { id: 'reason', codes: [{ id: 1, score: 2, manualInstruction: 'Begründung korrekt' }] };
    const repository = { find: jest.fn().mockResolvedValue([unit]), save: jest.fn().mockResolvedValue(unit) };
    const manager = { getRepository: jest.fn(entity => (entity === ResponseEntity ? { findOne: jest.fn().mockImplementation(async () => response) } : repository)) };
    const access = { assertAssignedCoderAccess: jest.fn().mockResolvedValue(undefined) };
    const mutation = { withLockedCodingJobById: jest.fn(async (_id, callback) => callback(job, manager)) };
    const schemes = {
      getCodingSchemesForUnits: jest.fn().mockImplementation(async () => new Map([[unit, {}]])),
      findVariableCoding: jest.fn().mockImplementation(() => rubric),
      validateProgressSelectedCode: jest.fn().mockResolvedValue({ id: 1, score: 2 })
    };
    const service = new McpManualCaseService(mutation as never, access as never, schemes as never);
    const progress = new CodingJobProgressService({} as never, {} as never, {} as never, {} as never, access as never, mutation as never, {} as never, schemes as never);
    Object.defineProperty(progress, 'getCodingJobUnitForEntry', { value: jest.fn().mockResolvedValue(unit) });
    Object.defineProperty(progress, 'checkAndUpdateCodingJobCompletion', { value: jest.fn().mockResolvedValue(undefined) });
    return {
      job, unit, response, rubric, repository, manager, access, mutation, schemes, service, progress
    };
  }

  it('returns the original answer and rubric under the assigned-coder job lock', async () => {
    const c = setup();
    const result = await c.service.get(12, 3, 18, 8);
    expect(c.mutation.withLockedCodingJobById).toHaveBeenCalledWith(3, expect.any(Function));
    expect(c.access.assertAssignedCoderAccess).toHaveBeenCalledWith(3, 12, 8, c.manager);
    expect(result).toMatchObject({
      response_id: 18, test_person: 'pilot@p1@G8@B1', value: c.response.value, rubric: c.rubric
    });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects foreign workspaces, unassigned coders and ambiguous response assignments', async () => {
    const c = setup();
    await expect(c.service.get(99, 3, 18, 8)).rejects.toThrow(NotFoundException);
    c.access.assertAssignedCoderAccess.mockRejectedValueOnce(new ForbiddenException());
    await expect(c.service.get(12, 3, 18, 8)).rejects.toThrow(ForbiddenException);
    c.repository.find.mockResolvedValueOnce([c.unit, c.unit]);
    await expect(c.service.get(12, 3, 18, 8)).rejects.toThrow(ConflictException);
    c.response.unit.booklet.person.workspace_id = 99;
    await expect(c.service.get(12, 3, 18, 8)).rejects.toThrow(NotFoundException);
  });

  it.each(['answer', 'rubric', 'decision', 'job', 'freshness'] as const)('rejects a stale %s before saving or validating a new code', async changed => {
    const c = setup();
    const before = await manualCaseSnapshot(c.job, c.unit, c.manager as never, c.schemes as never);
    if (changed === 'answer') c.response.value = 'Different answer';
    if (changed === 'rubric') c.rubric.codes[0].score = 3;
    if (changed === 'decision') c.unit.notes = 'Another coder changed this';
    if (changed === 'job') c.job.status = 'completed';
    if (changed === 'freshness') c.job.freshness_status = 'stale_source';
    await expect(c.progress.saveCodingProgress(3, {
      testPerson: before.test_person,
      unitId: 'G8-05',
      variableId: 'reason',
      selectedCode: { id: 1, score: 999 },
      notes: 'Begründung geprüft',
      expectedRevision: before.revision
    }, 8)).rejects.toThrow(ConflictException);
    expect(c.repository.save).not.toHaveBeenCalled();
    expect(c.schemes.validateProgressSelectedCode).not.toHaveBeenCalled();
  });

  it('saves a current revision with the native rubric score and invalidates its revision', async () => {
    const c = setup();
    const before = await c.service.get(12, 3, 18, 8);
    await c.progress.saveCodingProgress(3, {
      testPerson: before.test_person,
      unitId: 'G8-05',
      variableId: 'reason',
      selectedCode: { id: 1, score: 999 },
      notes: 'Begründung geprüft',
      expectedRevision: before.revision
    }, 8);
    expect(c.repository.save).toHaveBeenCalledWith(expect.objectContaining({ code: 1, score: 2, notes: 'Begründung geprüft' }));
    expect((await c.service.get(12, 3, 18, 8)).revision).not.toBe(before.revision);
  });
});
