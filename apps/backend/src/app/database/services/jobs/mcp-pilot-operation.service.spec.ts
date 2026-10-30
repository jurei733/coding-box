import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { McpPilotOperation } from '../../entities/mcp-pilot-operation.entity';
import User from '../../entities/user.entity';
import WorkspaceUser from '../../entities/workspace_user.entity';
import { JobQueueService } from '../../../job-queue/job-queue.service';
import { TestcenterService } from '../test-results/testcenter.service';
import { CodingProcessService } from '../coding/coding-process.service';
import { AutoCodingRunGuardService } from '../coding/auto-coding-run-guard.service';
import { StartMcpTestcenterImportDto } from '../../../admin/workspace/dto/mcp-pilot-request.dto';
import { McpPilotConfigService } from './mcp-pilot-config.service';
import { McpPilotOperationService } from './mcp-pilot-operation.service';

function fixture() {
  const rows = new Map<string, McpPilotOperation>();
  const matches = (row: McpPilotOperation, criteria: Record<string, unknown>) => Object.entries(criteria).every(([key, value]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];
    return value instanceof FindOperator ? (value.value as unknown[]).includes(actual) : value === actual;
  });
  const repository = {
    create: jest.fn(value => ({ ...value, created_at: new Date(), updated_at: new Date() })),
    findOneBy: jest.fn(async criteria => structuredClone([...rows.values()].find(row => matches(row, criteria)) || null)),
    findOneByOrFail: jest.fn(async criteria => {
      const row = [...rows.values()].find(item => matches(item, criteria)); if (!row) throw new Error('missing'); return structuredClone(row);
    }),
    insert: jest.fn(async (operation: McpPilotOperation) => {
      const conflict = [...rows.values()].some(row => row.workspace_id === operation.workspace_id && (
        ['queued', 'running'].includes(row.status) ||
        (row.actor_id === operation.actor_id && row.kind === operation.kind && row.request_key === operation.request_key)
      ));
      if (conflict) throw Object.assign(new Error('unique'), { code: '23505' });
      rows.set(operation.id, structuredClone(operation));
    }),
    update: jest.fn(async (criteria, change) => {
      let affected = 0;
      for (const row of rows.values()) if (matches(row, criteria)) { Object.assign(row, change); affected += 1; }
      return { affected };
    }),
    createQueryBuilder: jest.fn(() => {
      let id = '';
      const builder = { addSelect: () => builder, where: (_sql: string, params: { id: string }) => { id = params.id; return builder; }, getOne: async () => structuredClone(rows.get(id) || null) };
      return builder;
    })
  };
  const roles = new Map([[3, 3], [4, 1], [5, 3]]);
  const people = { find: jest.fn().mockResolvedValue([{ id: 101 }, { id: 102 }]) };
  const connection = {
    getRepository: jest.fn(entity => {
      if (entity === User) return { findOne: jest.fn(async ({ where }) => ({ id: where.id, isAdmin: where.id === 9 })) };
      if (entity === WorkspaceUser) return { findOneBy: jest.fn(async ({ userId }) => ({ accessLevel: roles.get(userId) ?? 0 })) };
      return people;
    })
  };
  const child = {
    data: { workspaceId: 17 },
    getState: jest.fn().mockResolvedValue('completed'),
    returnvalue: { totalResponses: 30, statusCounts: { CODING_COMPLETE: 30 } },
    progress: jest.fn().mockResolvedValue(100),
    finished: jest.fn().mockResolvedValue({})
  };
  const queues = {
    addMcpPilotJob: jest.fn().mockResolvedValue({}),
    getMcpPilotJob: jest.fn().mockResolvedValue({ getState: async () => 'active' }),
    getTestPersonCodingJob: jest.fn().mockResolvedValue(child),
    assertNoDependencyConflicts: jest.fn().mockResolvedValue(undefined)
  };
  const importResult = {
    success: true, responses: 1, logs: 0, testFiles: 12, persons: 10, booklets: 10, units: 30, importedGroups: ['PILOT01_group']
  };
  const testcenter = {
    importWorkspaceFiles: jest.fn().mockResolvedValue(importResult),
    getImportWorkspaceFilesProgress: jest.fn().mockResolvedValue({ status: 'running', totalPlanned: 1, totalProcessed: 0 })
  };
  const coding = { codeTestPersons: jest.fn().mockResolvedValue({ jobId: 'child-1' }) };
  const guard = { assertAutoCodingRunCanStart: jest.fn().mockResolvedValue(undefined) };
  const config = new McpPilotConfigService(new ConfigService({
    MCP_PILOT_ENABLED: 'true',
    MCP_PILOT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
    MCP_PILOT_TESTCENTERS: JSON.stringify({ pilot: { url: 'https://tc.example.org', workspace_ids: [42] } })
  }));
  const service = new McpPilotOperationService(repository as unknown as Repository<McpPilotOperation>, connection as unknown as DataSource, config, queues as unknown as JobQueueService, testcenter as unknown as TestcenterService, coding as unknown as CodingProcessService, guard as unknown as AutoCodingRunGuardService);
  const body = plainToInstance(StartMcpTestcenterImportDto, {
    server_id: 'pilot',
    tc_workspace_id: 42,
    groups: ['PILOT01_group'],
    options: {},
    response_overwrite_mode: 'skip',
    request_key: 'pilot-import'
  });
  return {
    service, rows, roles, queues, testcenter, coding, child, body, repository, config, people, importResult
  };
}

describe('MCP pilot operations', () => {
  it('registers concurrent retries exactly once and does not put a source token into Bull', async () => {
    const f = fixture();
    const starts = await Promise.all([f.service.startImport(17, 3, f.body, 'secret-source-token'), f.service.startImport(17, 3, f.body, 'secret-source-token')]);
    expect(starts[0].operation_id).toBe(starts[1].operation_id);
    expect(f.queues.addMcpPilotJob).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.queues.addMcpPilotJob.mock.calls)).not.toContain('secret-source-token');
    expect(f.rows.get(starts[0].operation_id)?.credential).not.toContain('secret-source-token');
    expect(JSON.stringify(starts)).not.toContain('credential');
  });

  it('rejects a changed payload for the same request key', async () => {
    const f = fixture(); await f.service.startImport(17, 3, f.body, 'token');
    await expect(f.service.startImport(17, 3, { ...f.body, groups: ['other'] }, 'token')).rejects.toBeInstanceOf(ConflictException);
    expect(f.queues.addMcpPilotJob).toHaveBeenCalledTimes(1);
  });

  it('prevents a second active operation for the same workspace', async () => {
    const f = fixture(); await f.service.startImport(17, 3, f.body, 'token');
    await expect(f.service.startCoding(17, 3, { auto_coder_run: 1, request_key: 'code' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('enforces study-manager access before registration and again at execution', async () => {
    const f = fixture();
    await expect(f.service.startImport(17, 4, f.body, 'token')).rejects.toBeInstanceOf(ForbiddenException);
    const start = await f.service.startImport(17, 3, f.body, 'token'); f.roles.set(3, 1);
    await f.service.execute(start.operation_id);
    expect(f.rows.get(start.operation_id)?.status).toBe('failed');
    expect(f.testcenter.importWorkspaceFiles).not.toHaveBeenCalled();
    expect(f.rows.get(start.operation_id)?.credential).toBeNull();
  });

  it('does not expose another owner or a different endpoint kind, including to an admin', async () => {
    const f = fixture(); const start = await f.service.startImport(17, 3, f.body, 'token');
    await expect(f.service.status(17, 9, start.operation_id, 'testcenter-import')).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.status(17, 3, start.operation_id, 'autocoding')).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.status(18, 3, start.operation_id, 'testcenter-import')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the existing import service, deletes credentials before I/O and ignores redelivery', async () => {
    const f = fixture(); const start = await f.service.startImport(17, 3, f.body, 'source-token');
    f.testcenter.importWorkspaceFiles.mockImplementation(async () => {
      expect(f.rows.get(start.operation_id)?.credential).toBeNull(); return f.importResult;
    });
    await f.service.execute(start.operation_id); await f.service.execute(start.operation_id);
    expect(f.testcenter.importWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(f.testcenter.importWorkspaceFiles).toHaveBeenCalledWith('17', '42', 'pilot', 'https://tc.example.org', 'source-token', expect.objectContaining({ responses: 'true' }), 'PILOT01_group', false, undefined, start.operation_id, 'skip', 3);
    const status = await f.service.status(17, 3, start.operation_id, 'testcenter-import');
    expect(status).toMatchObject({ status: 'succeeded', progress: 100, statistics: { persons: 10, import_tasks: 1 } });
  });

  it('marks partial imports as needing attention and never replays them', async () => {
    const f = fixture(); f.testcenter.importWorkspaceFiles.mockResolvedValue({ ...f.importResult, success: false });
    const start = await f.service.startImport(17, 3, f.body, 'token'); await f.service.execute(start.operation_id);
    const repeated = await f.service.startImport(17, 3, f.body, 'new-token');
    expect(repeated).toMatchObject({ status: 'needs_attention', error: { code: 'PARTIAL_IMPORT' } });
    expect(f.queues.addMcpPilotJob).toHaveBeenCalledTimes(1);
  });

  it('sanitizes worker errors and wipes expired credentials without contacting Testcenter', async () => {
    const f = fixture(); const start = await f.service.startImport(17, 3, f.body, 'secret');
    f.rows.get(start.operation_id)!.credential_expires_at = new Date(0);
    await f.service.execute(start.operation_id);
    expect(f.testcenter.importWorkspaceFiles).not.toHaveBeenCalled();
    expect(f.rows.get(start.operation_id)).toMatchObject({ status: 'failed', credential: null, error_code: 'SOURCE_CREDENTIAL_EXPIRED' });
  });

  it('handles an uncertain queue submission without resubmitting or starting mutations', async () => {
    const f = fixture(); f.queues.addMcpPilotJob.mockRejectedValue(new Error('secret source-token'));
    const start = await f.service.startImport(17, 3, f.body, 'source-token');
    expect(start.status).toBe('needs_attention'); expect(JSON.stringify(start)).not.toContain('source-token');
    await f.service.execute(start.operation_id); await f.service.startImport(17, 3, f.body, 'source-token');
    expect(f.testcenter.importWorkspaceFiles).not.toHaveBeenCalled(); expect(f.queues.addMcpPilotJob).toHaveBeenCalledTimes(1);
  });

  it('resolves numeric group names to persons within the workspace before using the coding engine', async () => {
    const f = fixture(); const start = await f.service.startCoding(17, 3, { auto_coder_run: 1, groups: ['123'], request_key: 'code' });
    await f.service.execute(start.operation_id);
    expect(f.people.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspace_id: 17, consider: true }) }));
    expect(f.coding.codeTestPersons).toHaveBeenCalledWith(17, '101,102', 1);
    expect(await f.service.status(17, 3, start.operation_id, 'autocoding')).toMatchObject({ status: 'succeeded', statistics: { totalResponses: 30, result_version: 'v1' } });
    f.queues.getMcpPilotJob.mockRejectedValue(new Error('Redis unavailable'));
    expect((await f.service.status(17, 3, start.operation_id, 'autocoding')).status).toBe('succeeded');
  });

  it('does not launch another coding job after a worker interruption', async () => {
    const f = fixture(); const start = await f.service.startCoding(17, 3, { auto_coder_run: 1, request_key: 'code' });
    f.child.finished.mockRejectedValue(new Error('upstream failure with secret'));
    await f.service.execute(start.operation_id); await f.service.execute(start.operation_id);
    const status = await f.service.status(17, 3, start.operation_id, 'autocoding');
    expect(status.status).toBe('needs_attention'); expect(JSON.stringify(status)).not.toContain('secret');
    expect(f.coding.codeTestPersons).toHaveBeenCalledTimes(1);
  });

  it('reconciles a stopped import from its existing durable outcome', async () => {
    const f = fixture(); const start = await f.service.startImport(17, 3, f.body, 'token');
    Object.assign(f.rows.get(start.operation_id)!, { status: 'running', credential: null });
    f.testcenter.getImportWorkspaceFilesProgress.mockResolvedValue({
      status: 'completed', totalPlanned: 12, totalProcessed: 12, result: f.importResult
    } as never);
    expect((await f.service.status(17, 3, start.operation_id, 'testcenter-import')).status).toBe('succeeded');
    expect(f.testcenter.importWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('preserves partial-error semantics when reconciling a native import after interruption', async () => {
    const f = fixture(); const start = await f.service.startImport(17, 3, f.body, 'token');
    Object.assign(f.rows.get(start.operation_id)!, { status: 'running', credential: null });
    f.testcenter.getImportWorkspaceFilesProgress.mockResolvedValue({
      status: 'completed',
      totalPlanned: 12,
      totalProcessed: 12,
      result: { ...f.importResult, issues: [{ level: 'error', message: 'Source detail must not appear in public status.' }] }
    } as never);
    const status = await f.service.status(17, 3, start.operation_id, 'testcenter-import');
    expect(status.status).toBe('needs_attention'); expect(status.statistics?.error_count).toBe(1);
    expect(JSON.stringify(status)).not.toContain('Source detail');
    expect(f.testcenter.importWorkspaceFiles).not.toHaveBeenCalled();
  });
});
