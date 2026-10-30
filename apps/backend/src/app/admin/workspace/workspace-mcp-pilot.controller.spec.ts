import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { WorkspaceMcpPilotController } from './workspace-mcp-pilot.controller';
import { McpPilotOperationService } from '../../database/services/jobs/mcp-pilot-operation.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { AccessLevelGuard } from './access-level.guard';

describe('MCP pilot HTTP endpoints', () => {
  let app: INestApplication;
  let url: string;
  const id = '9d5d6420-6730-4480-b8dc-a557fe3bb938';
  const operations = { startImport: jest.fn(), startCoding: jest.fn(), status: jest.fn() };
  const body = {
    server_id: 'pilot', tc_workspace_id: 42, groups: ['PILOT01_group'], options: {}, response_overwrite_mode: 'skip', request_key: 'start'
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [WorkspaceMcpPilotController], providers: [{ provide: McpPilotOperationService, useValue: operations }] })
      .overrideGuard(JwtAuthGuard).useValue({
        canActivate: context => {
          const request = context.switchToHttp().getRequest();
          if (request.headers.authorization !== 'Bearer test') throw new UnauthorizedException();
          request.user = { id: 3 }; return true;
        }
      }).overrideGuard(WorkspaceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AccessLevelGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks(); operations.startImport.mockResolvedValue({ import_run_id: id, status: 'queued' });
    operations.startCoding.mockResolvedValue({ run_id: id, status: 'queued' }); operations.status.mockResolvedValue({ operation_id: id, status: 'succeeded' });
  });

  async function post(path: string, input: unknown, authenticated = true) {
    return fetch(`${url}/api/admin/workspace/17/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-IQB-Testcenter-Token': 'source-token', ...(authenticated ? { Authorization: 'Bearer test' } : {})
      },
      body: JSON.stringify(input)
    });
  }

  it('requires JWT, workspace access and study-manager role on every endpoint', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WorkspaceMcpPilotController)).toEqual([JwtAuthGuard, WorkspaceGuard, AccessLevelGuard]);
    expect(Reflect.getMetadata('accessLevel', WorkspaceMcpPilotController)).toBe(3);
  });

  it('serves both POST and both status endpoints with actor and workspace binding', async () => {
    expect((await post('testcenter-imports', body)).status).toBe(202);
    expect(operations.startImport).toHaveBeenCalledWith(17, 3, expect.objectContaining({ options: expect.objectContaining({ responses: true, logs: false }) }), 'source-token');
    expect((await post('autocoding-runs', { auto_coder_run: 1, groups: ['PILOT01_group'], request_key: 'code' })).status).toBe(202);
    for (const [path, kind] of [['testcenter-imports', 'testcenter-import'], ['autocoding-runs', 'autocoding']]) {
      expect((await fetch(`${url}/api/admin/workspace/17/${path}/${id}`, { headers: { Authorization: 'Bearer test' } })).status).toBe(200);
      expect(operations.status).toHaveBeenCalledWith(17, 3, id, kind);
    }
  });

  it('rejects unknown keys, replacement mode, null options, bad groups and numeric strings', async () => {
    for (const input of [{ ...body, url: 'https://untrusted.example.org' }, { ...body, token: 'secret' }, { ...body, response_overwrite_mode: 'replace' },
      { ...body, options: null }, { ...body, options: [] }, { ...body, options: { responses: null } }, { ...body, options: { other: true } },
      { ...body, groups: [] }, { ...body, groups: ['g', 'g'] }, { ...body, tc_workspace_id: '42' }]) {
      expect((await post('testcenter-imports', input)).status).toBe(400);
    }
    expect(operations.startImport).not.toHaveBeenCalled();
    expect((await post('autocoding-runs', { auto_coder_run: 2, request_key: 'code' })).status).toBe(400);
    expect((await post('autocoding-runs', { auto_coder_run: 1, groups: null, request_key: 'code' })).status).toBe(400);
    expect((await post('autocoding-runs', { auto_coder_run: 1, request_key: 'code' }, false)).status).toBe(401);
    expect(operations.startCoding).not.toHaveBeenCalled();
  });
});
