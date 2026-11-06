import { DataSource } from 'typeorm';
import { WorkspaceFilesService } from './workspace-files.service';

describe('Workspace VOMD item lookup', () => {
  const makeService = (find: jest.Mock) => Object.assign(
    Object.create(WorkspaceFilesService.prototype), {
      fileUploadRepository: { find },
      logger: { warn: jest.fn(), error: jest.fn() }
    }
  ) as WorkspaceFilesService;

  it('generates a case-insensitive PostgreSQL filename lookup with the workspace and resource bounds', async () => {
    const source = new DataSource({ type: 'postgres' });
    let query: [string, unknown[]] | undefined;
    const find = jest.fn(async options => {
      query = source
        .createQueryBuilder()
        .select('file.filename')
        .from('file_upload', 'file')
        .where(options.where)
        .getQueryAndParameters();
      return [
        {
          id: 17,
          file_id: 'G8.VOMD',
          filename: 'G8.VOMD',
          data: JSON.stringify({ items: [{ id: 'G8-ITEM' }] })
        }
      ];
    });
    expect(await makeService(find).getItemIdsFromMetadataFiles(37)).toEqual([
      { id: 17, fileId: 'G8.VOMD', items: ['G8-ITEM'] }
    ]);
    expect(query).toBeDefined();
    expect(query![0]).toMatch(/file\.filename ILIKE \$3/);
    expect(query![0]).toContain('file.workspace_id = $1');
    expect(query![0]).toContain('file.file_type = $2');
    expect(query![1]).toEqual([37, 'Resource', '%.vomd']);
  });

  it('preserves source file identifiers and sorts the extracted identifiers deterministically', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 9,
        file_id: 'Z.VOMD',
        data: JSON.stringify({ items: [{ id: 'ITEM-B' }, { id: 'ITEM-A' }] })
      },
      {
        id: 7,
        file_id: 'A.VoMd',
        data: JSON.stringify({ items: [{ id: 17 }] })
      }
    ]);
    expect(await makeService(find).getItemIdsFromMetadataFiles(37)).toEqual([
      { id: 7, fileId: 'A.VoMd', items: ['17'] },
      { id: 9, fileId: 'Z.VOMD', items: ['ITEM-A', 'ITEM-B'] }
    ]);
  });

  it('keeps valid item mappings when another resource contains malformed or empty metadata', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 1,
        file_id: 'BROKEN.VOMD',
        filename: 'BROKEN.VOMD',
        data: '{'
      },
      { id: 2, file_id: 'EMPTY.VOMD', data: '{"items":[]}' },
      { id: 3, file_id: 'VALID.VOMD', data: '{"items":[{"id":"ITEM-1"}]}' }
    ]);
    expect(await makeService(find).getItemIdsFromMetadataFiles(37)).toEqual([
      { id: 3, fileId: 'VALID.VOMD', items: ['ITEM-1'] }
    ]);
  });
});
