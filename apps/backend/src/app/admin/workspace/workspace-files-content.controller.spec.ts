import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WorkspaceFilesContentController } from './workspace-files-content.controller';
import { WorkspaceFilesService } from '../../database/services/workspace';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { createRequestValidationPipe } from '../../http/request-validation';

describe('Unit file content HTTP identifiers', () => {
  let app: INestApplication;
  let getContent: jest.Mock;

  beforeEach(async () => {
    getContent = jest.fn(async (_workspace: string, fileId: string) => {
      if (fileId === 'MISSING') throw new NotFoundException('Unit file not found');
      return `<Unit><Metadata><Id>${fileId}</Id></Metadata></Unit>`;
    });
    const module = await Test.createTestingModule({
      controllers: [WorkspaceFilesContentController],
      providers: [{ provide: WorkspaceFilesService, useValue: { getUnitContent: getContent } }]
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createRequestValidationPipe());
    await app.init();
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => app?.close());

  it.each(['G8-SCHULGARTEN-01', '17', '0'])(
    'reads the exact stored file identifier %s without numeric conversion',
    async fileId => {
      const response = await fetch(`${await app.getUrl()}/admin/workspace/1/unit/${encodeURIComponent(fileId)}/content`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ content: `<Unit><Metadata><Id>${fileId}</Id></Metadata></Unit>` });
      expect(getContent).toHaveBeenCalledWith('1', fileId);
    }
  );

  it('advertises a string file identifier and a numeric workspace in OpenAPI', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const parameters = document.paths['/admin/workspace/{workspace_id}/unit/{unit_id}/content']?.get?.parameters;
    expect(parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'unit_id', in: 'path', schema: expect.objectContaining({ type: 'string' }) }),
      expect.objectContaining({ name: 'workspace_id', in: 'path', schema: expect.objectContaining({ type: 'number' }) })
    ]));
  });

  it('rejects a blank file identifier before the file lookup', async () => {
    const response = await fetch(`${await app.getUrl()}/admin/workspace/1/unit/%20/content`);
    expect(response.status).toBe(400);
    expect(getContent).not.toHaveBeenCalled();
  });

  it('preserves the not-found result for an unknown string file identifier', async () => {
    const response = await fetch(`${await app.getUrl()}/admin/workspace/1/unit/MISSING/content`);
    expect(response.status).toBe(404);
    expect(getContent).toHaveBeenCalledWith('1', 'MISSING');
  });

  it.each(['other', '0', '-1'])(
    'retains numeric workspace validation for %s',
    async workspace => {
      const response = await fetch(`${await app.getUrl()}/admin/workspace/${workspace}/unit/G8-SCHULGARTEN-01/content`);
      expect(response.status).toBe(400);
      expect(getContent).not.toHaveBeenCalled();
    }
  );
});
