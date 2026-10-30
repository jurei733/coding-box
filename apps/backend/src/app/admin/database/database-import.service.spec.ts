import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as sqlite3 from 'sqlite3';
import { DataSource } from 'typeorm';
import {
  DatabaseImportService,
  remapSnapshotJson
} from './database-import.service';
import { DatabaseExportService } from './database-export.service';

describe('SQLite workspace restore', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'coding-snapshot-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('remaps job references while preserving response variable IDs and point values', () => {
    const maps = new Map([
      ['coding_job', new Map([['2', 200]])],
      ['user', new Map([['1', 100]])]
    ]);
    expect(
      remapSnapshotJson(
        {
          jobs: [{
            jobId: 2, coderId: 1, variableId: '2', score: 2
          }]
        },
        maps
      )
    ).toEqual({
      jobs: [{
        jobId: 200, coderId: 100, variableId: '2', score: 2
      }]
    });
    expect(() => remapSnapshotJson({ jobId: 3 }, maps)).toThrow(
      'Unresolved snapshot reference'
    );
  });

  it('rejects non-SQLite input before querying PostgreSQL', async () => {
    const path = join(directory, 'bad.sqlite');
    await writeFile(path, 'not sqlite');
    const source = { query: jest.fn() };
    await expect(
      new DatabaseImportService(
        source as unknown as DataSource,
        {} as DatabaseExportService
      ).importWorkspace(path, 12, 1)
    ).rejects.toThrow('SQLite snapshot');
    expect(source.query).not.toHaveBeenCalled();
  });

  it('rejects unsupported tables before starting a PostgreSQL mutation', async () => {
    const path = join(directory, 'snapshot.sqlite');
    const db = new sqlite3.Database(path);
    await new Promise<void>((resolve, reject) => { db.exec('CREATE TABLE secret_user(id INTEGER);', error => { if (error) reject(error); else resolve(); }); });
    await new Promise<void>((resolve, reject) => { db.close(error => { if (error) reject(error); else resolve(); }); });
    const source = { query: jest.fn(), manager: { transaction: jest.fn() } };
    const exports = {
      getWorkspaceExportTables: () => [{ name: 'workspace', query: '' }]
    };
    await expect(
      new DatabaseImportService(
        source as unknown as DataSource,
        exports as DatabaseExportService
      ).importWorkspace(path, 12, 1)
    ).rejects.toThrow('unsupported tables');
    expect(source.manager.transaction).not.toHaveBeenCalled();
  });

  it('rejects executable schema objects', async () => {
    const path = join(directory, 'trigger.sqlite');
    const db = new sqlite3.Database(path);
    await new Promise<void>((resolve, reject) => { db.exec('CREATE TABLE workspace(id INTEGER);CREATE VIEW data AS SELECT 1;', error => { if (error) reject(error); else resolve(); }); });
    await new Promise<void>((resolve, reject) => { db.close(error => { if (error) reject(error); else resolve(); }); });
    const source = { query: jest.fn() };
    const exports = { getWorkspaceExportTables: () => [{ name: 'workspace' }] };
    await expect(
      new DatabaseImportService(
        source as unknown as DataSource,
        exports as DatabaseExportService
      ).importWorkspace(path, 12, 1)
    ).rejects.toThrow('ordinary snapshot tables');
    expect(source.query).not.toHaveBeenCalled();
  });
});
