import {
  BadRequestException,
  ConflictException,
  Injectable
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as sqlite3 from 'sqlite3';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { DatabaseExportService } from './database-export.service';
import {
  lockWorkspaceTestResultsMutationInTransaction,
  withWorkspaceTestResultsMutationTransaction
} from '../../database/services/shared/workspace-test-results-lock.util';

type Row = Record<string, unknown>;
type Column = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};
type ForeignKey = {
  table_name: string;
  column_name: string;
  foreign_table: string;
  foreign_column: string;
};
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const referenceByColumn: Record<string, string> = {
  workspace_id: 'workspace',
  unitid: 'unit',
  unit_id: 'unit',
  personid: 'persons',
  person_id: 'persons',
  bookletid: 'booklet',
  booklet_id: 'booklet',
  infoid: 'bookletinfo',
  response_id: 'response',
  coding_job_id: 'coding_job',
  source_coding_job_id: 'coding_job',
  job_definition_id: 'job_definitions',
  training_id: 'coder_training',
  coder_training_id: 'coder_training',
  variable_bundle_id: 'variable_bundle',
  missings_profile_id: 'missings_profile',
  user_id: 'user',
  coder_id: 'user',
  creator_user_id: 'user',
  reviewer_user_id: 'user',
  actor_user_id: 'user'
};

export function remapSnapshotJson(
  value: unknown,
  maps: Map<string, Map<string, number>>,
  parent = ''
): unknown {
  const known: Record<string, string> = {
    coderId: 'user',
    userId: 'user',
    jobId: 'coding_job',
    codingJobId: 'coding_job',
    jobDefinitionId: 'job_definitions',
    responseId: 'response',
    missingsProfileId: 'missings_profile',
    variableBundleId: 'variable_bundle'
  };
  if (Array.isArray(value)) return value.map(item => remapSnapshotJson(item, maps, parent));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const table =
        known[key] ||
        (key === 'id' && /variable.?bundles/i.test(parent) ?
          'variable_bundle' :
          undefined);
      if (table && item !== null) {
        const mapped = maps.get(table)?.get(String(item));
        if (mapped === undefined) {
          throw new BadRequestException(
            `Unresolved snapshot reference: ${key}`
          );
        }
        return [key, mapped];
      }
      return [key, remapSnapshotJson(item, maps, key)];
    })
  );
}

/** Copies only the native workspace export graph into an empty workspace.
 * Global users and access rights are never restored from an uploaded file. */
@Injectable()
export class DatabaseImportService {
  constructor(
    @InjectDataSource() private readonly source: DataSource,
    private readonly exports: DatabaseExportService
  ) {}

  async importWorkspace(
    path: string,
    workspaceId: number,
    actorId: number,
    userMap: Record<string, number> = {}
  ) {
    const bytes = await readFile(path);
    if (
      bytes.length > 64 * 1024 * 1024 ||
      bytes.subarray(0, 16).toString() !== 'SQLite format 3\0'
    ) {
      throw new BadRequestException(
        'A SQLite snapshot up to 64 MiB is required.'
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sqlite = await new Promise<sqlite3.Database>((resolve, reject) => {
      const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, error => (error ? reject(error) : resolve(db))
      );
    });
    const all = (sql: string, params: unknown[] = []): Promise<Row[]> => new Promise((resolve, reject) => {
      sqlite.all(sql, params, (error, rows: Row[]) => { if (error) reject(error); else resolve(rows); });
    });
    try {
      const catalog = await all(
        "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
      );
      if (
        catalog.some(
          r => r.type !== 'table' ||
            /\bVIRTUAL\b|\bGENERATED\b/i.test(String(r.sql))
        )
      ) {
        throw new BadRequestException(
          'Only ordinary snapshot tables are supported.'
        );
      }
      const allowed = new Set(
        this.exports.getWorkspaceExportTables().map(t => t.name)
      );
      if (catalog.some(r => !allowed.has(String(r.name)))) throw new BadRequestException('Snapshot contains unsupported tables.');
      const sourceWorkspaces = await all('SELECT * FROM workspace');
      if (sourceWorkspaces.length !== 1) throw new BadRequestException('Exactly one workspace is required.');
      const sourceId = sourceWorkspaces[0].id;
      const existingTables = new Set(
        (
          await this.source.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
          )
        ).map((row: { table_name: string }) => row.table_name)
      );
      const tables = new Map<string, { columns: Column[]; rows: Row[] }>();
      let totalRows = 0;
      for (const entry of catalog) {
        const name = String(entry.name);
        const columns: Column[] = await this.source.query(
          "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [name]
        );
        const incoming = await all(`PRAGMA table_info(${quote(name)})`);
        if (
          !columns.length ||
          incoming.some(
            c => !columns.some(column => column.column_name === c.name)
          )
        ) throw new BadRequestException(`Snapshot schema mismatch: ${name}`);
        const fields = incoming.map(c => String(c.name));
        const rows = await all(
          `SELECT ${fields.map(field => (columns.find(c => c.column_name === field)?.data_type === 'bigint' ? `CAST(${quote(field)} AS TEXT) AS ${quote(field)}` : quote(field))).join(',')} FROM ${quote(name)}`
        );
        totalRows += rows.length;
        if (totalRows > 500000) throw new BadRequestException('Snapshot exceeds 500000 rows.');
        if (
          rows.some(
            r => r.workspace_id !== undefined &&
              r.workspace_id !== null &&
              Number(r.workspace_id) !== Number(sourceId)
          )
        ) throw new BadRequestException('Snapshot contains another workspace.');
        tables.set(name, {
          columns: columns.filter(c => fields.includes(c.column_name)),
          rows
        });
      }
      for (const name of [
        'persons',
        'bookletinfo',
        'booklet',
        'unit',
        'response'
      ]) if (!tables.has(name)) throw new BadRequestException(`Missing snapshot table: ${name}`);
      return await withWorkspaceTestResultsMutationTransaction(
        this.source.manager,
        async manager => {
          await lockWorkspaceTestResultsMutationInTransaction(
            manager,
            workspaceId
          );
          const targets = await manager.query(
            'SELECT id,settings FROM workspace WHERE id=$1 FOR UPDATE',
            [workspaceId]
          );
          if (targets.length !== 1) throw new BadRequestException('Target workspace does not exist.');
          if (targets[0].settings?.iqbSqliteImportReceipt?.sha256 === sha256) return targets[0].settings.iqbSqliteImportReceipt.result;
          for (const table of this.exports.getWorkspaceExportTables()) {
            if (
              table.name === 'workspace' ||
              table.name === 'bookletinfo' ||
              !existingTables.has(table.name)
            ) continue;
            const count = await manager.query(
              `SELECT COUNT(*) n FROM (${table.query}) snapshot_target`,
              [workspaceId]
            );
            if (Number(count[0].n)) {
              throw new ConflictException(
                'SQLite import requires an empty target workspace.'
              );
            }
          }
          const foreign: ForeignKey[] = await manager.query(
            'SELECT tc.table_name,kcu.column_name,ccu.table_name AS foreign_table,ccu.column_name AS foreign_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema WHERE tc.constraint_type=\'FOREIGN KEY\' AND tc.table_schema=\'public\''
          );
          const maps = new Map<string, Map<string, number>>([
            ['workspace', new Map([[String(sourceId), workspaceId]])],
            ['user', new Map()]
          ]);
          const lookup = (table: string, column: string): string | undefined => foreign.find(
            f => f.table_name === table && f.column_name === column
          )?.foreign_table || referenceByColumn[column];
          // Allocate all IDs before inserting; never reuse source primary keys.
          for (const [name, data] of [...tables].sort(([a], [b]) => a.localeCompare(b)
          )) {
            if (
              name === 'workspace' ||
              !data.columns.some(c => c.column_name === 'id')
            ) continue;
            const mapping = new Map<string, number>();
            maps.set(name, mapping);
            if (
              new Set(data.rows.map(r => String(r.id))).size !==
              data.rows.length
            ) throw new BadRequestException('Duplicate snapshot IDs.');
            const sequence = await manager.query(
              "SELECT pg_get_serial_sequence($1,'id') AS name",
              [name]
            );
            let next = 0;
            if (!sequence[0].name) {
              await manager.query(
                `LOCK TABLE ${quote(name)} IN SHARE ROW EXCLUSIVE MODE`
              );
              const maximum = await manager.query(
                `SELECT COALESCE(MAX(id),0) n FROM ${quote(name)}`
              );
              next = Number(maximum[0].n);
            }
            const allocated = sequence[0].name ?
              await manager.query(
                'SELECT nextval($1::regclass) id FROM generate_series(1,$2)',
                [sequence[0].name, data.rows.length]
              ) :
              [];
            for (const [index, row] of data.rows.entries()) {
              if (name === 'bookletinfo') {
                const existing = await manager.query(
                  'SELECT id,size FROM bookletinfo WHERE name=$1',
                  [row.name]
                );
                if (existing.length) {
                  if (String(existing[0].size) !== String(row.size ?? 0)) {
                    throw new ConflictException(
                      'Existing booklet size differs from snapshot.'
                    );
                  }
                  mapping.set(String(row.id), Number(existing[0].id));
                  continue;
                }
              }
              mapping.set(
                String(row.id),
                allocated[index] ? Number(allocated[index].id) : (next += 1)
              );
            }
          }
          for (const [name, data] of tables) {
            for (const row of data.rows) {
              for (const column of data.columns) {
                if (
                  lookup(name, column.column_name) !== 'user' ||
                  row[column.column_name] === null
                ) continue;
                const id = String(row[column.column_name]);
                const mapped =
                  userMap[id] ?? (Number(id) === actorId ? actorId : undefined);
                if (
                  !mapped ||
                  !(
                    await manager.query('SELECT id FROM "user" WHERE id=$1', [
                      mapped
                    ])
                  ).length
                ) {
                  throw new BadRequestException(
                    'Explicit mapping is required for snapshot users other than the importing user.'
                  );
                }
                if (
                  !(
                    await manager.query(
                      'SELECT user_id FROM workspace_user WHERE workspace_id=$1 AND user_id=$2',
                      [workspaceId, mapped]
                    )
                  ).length
                ) {
                  throw new BadRequestException(
                    'Mapped coder must already have access to the target workspace.'
                  );
                }
                maps.get('user')!.set(id, mapped);
              }
            }
          }
          const remaining = new Set(
            [...tables.keys()].filter(
              t => t !== 'workspace' && tables.get(t)!.rows.length > 0
            )
          );
          while (remaining.size) {
            const ready = [...remaining].find(name => foreign
              .filter(
                f => f.table_name === name && f.foreign_table !== name
              )
              .every(f => !remaining.has(f.foreign_table))
            );
            if (!ready) {
              throw new BadRequestException(
                'Unsupported cyclic snapshot references.'
              );
            }
            const data = tables.get(ready)!;
            const rows: Row[] = [];
            for (const original of data.rows) {
              if (
                ready === 'bookletinfo' &&
                (
                  await manager.query(
                    'SELECT id FROM bookletinfo WHERE id=$1',
                    [maps.get(ready)!.get(String(original.id))]
                  )
                ).length
              ) continue;
              const row: Row = {};
              for (const column of data.columns) {
                const field = column.column_name;
                let value = original[field];
                const ref = field === 'id' ? ready : lookup(ready, field);
                if (ref && value !== null && value !== undefined) {
                  const mapped = maps.get(ref)?.get(String(value));
                  if (mapped === undefined) {
                    throw new BadRequestException(
                      `Unresolved snapshot reference: ${ready}.${field}`
                    );
                  }
                  value = mapped;
                }
                if (column.data_type === 'boolean' && value !== null) value = Number(value) !== 0;
                if (
                  column.data_type === 'jsonb' ||
                  column.data_type === 'json'
                ) {
                  if (typeof value === 'string') {
                    try {
                      value = JSON.parse(value);
                    } catch {
                      throw new BadRequestException(
                        'Invalid JSON in snapshot.'
                      );
                    }
                  }
                  if (
                    [
                      'job_definitions',
                      'coding_job',
                      'coder_training'
                    ].includes(ready)
                  ) value = remapSnapshotJson(value, maps, field);
                  value = value === null ? null : JSON.stringify(value);
                }
                row[field] = value;
              }
              rows.push(row);
            }
            await this.insert(manager, ready, rows, data.columns);
            remaining.delete(ready);
          }
          const counts = Object.fromEntries(
            [...tables].map(([name, data]) => [name, data.rows.length])
          );
          const result = {
            status: 'succeeded',
            workspace_id: workspaceId,
            source_workspace_id: sourceId,
            tables: counts,
            sha256
          };
          let settings: unknown = sourceWorkspaces[0].settings ?? {};
          if (typeof settings === 'string') settings = JSON.parse(settings);
          await manager.query('UPDATE workspace SET settings=$1 WHERE id=$2', [
            { ...(settings as object), iqbSqliteImportReceipt: { sha256, result } },
            workspaceId
          ]);
          return result;
        }
      );
    } finally {
      await new Promise<void>((resolve, reject) => { sqlite.close(error => { if (error) reject(error); else resolve(); }); });
    }
  }

  private async insert(
    manager: EntityManager,
    name: string,
    rows: Row[],
    columns: Column[]
  ) {
    const fields = columns.map(c => c.column_name);
    for (let offset = 0; offset < rows.length; offset += 300) {
      const batch = rows.slice(offset, offset + 300);
      const values: unknown[] = [];
      const sql = batch
        .map(
          row => `(${fields
            .map(field => {
              values.push(row[field]);
              return `$${values.length}`;
            })
            .join(',')})`
        )
        .join(',');
      await manager.query(
        `INSERT INTO ${quote(name)} (${fields.map(quote).join(',')}) VALUES ${sql}`,
        values
      );
    }
  }
}
