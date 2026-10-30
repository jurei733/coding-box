import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import Workspace from '../../entities/workspace.entity';
import User from '../../entities/user.entity';
import { McpPilotOperation } from '../../entities/mcp-pilot-operation.entity';

class MetadataSource extends DataSource {
  prepareMetadata(): Promise<void> { return this.buildMetadatas(); }
}

describe('MCP pilot persistence metadata', () => {
  it('registers workspace and actor ownership without synchronizing a database', async () => {
    const source = new MetadataSource({ type: 'postgres', entities: [Workspace, User, McpPilotOperation], synchronize: false });
    await source.prepareMetadata();
    const metadata = source.getMetadata(McpPilotOperation);
    expect(metadata.tableName).toBe('mcp_pilot_operation');
    expect(metadata.findColumnWithPropertyName('credential')?.isSelect).toBe(false);
    expect(metadata.indices.find(index => index.name === 'mcp_pilot_request_unique')?.isUnique).toBe(true);
    expect(metadata.relations).toHaveLength(2);
  });
});

const describePostgres = process.env.POSTGRES_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
describePostgres('MCP pilot PostgreSQL constraints (apply Liquibase first)', () => {
  let source: DataSource;
  let workspace: Workspace;
  let actor: User;
  beforeAll(async () => {
    source = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT || 5432),
      username: process.env.POSTGRES_USER || 'root',
      password: process.env.POSTGRES_PASSWORD || 'root-password',
      database: process.env.POSTGRES_DB || 'coding-box',
      entities: [Workspace, User, McpPilotOperation],
      synchronize: false
    });
    await source.initialize();
  });
  beforeEach(async () => {
    workspace = await source.getRepository(Workspace).save({ name: `mcp-test-${randomUUID()}` });
    actor = await source.getRepository(User).save({
      identity: randomUUID(), issuer: 'https://mcp-test.invalid', username: `mcp-test-${randomUUID()}`, isAdmin: false
    });
  });
  afterEach(async () => {
    if (workspace) await source.getRepository(Workspace).delete(workspace.id);
    if (actor) await source.getRepository(User).delete(actor.id);
  });
  afterAll(async () => { if (source?.isInitialized) await source.destroy(); });

  function operation(key: string) {
    return source.getRepository(McpPilotOperation).create({
      id: randomUUID(),
      workspace_id: workspace.id,
      actor_id: actor.id,
      kind: 'autocoding',
      request_key: key,
      request_hash: 'a'.repeat(64),
      payload: { auto_coder_run: 1 },
      status: 'queued',
      credential: null
    });
  }
  it('permits exactly one concurrent registration and remembers the request after completion', async () => {
    const repository = source.getRepository(McpPilotOperation);
    const outcomes = await Promise.allSettled([repository.insert(operation('same')), repository.insert(operation('same'))]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    const existing = await repository.findOneByOrFail({ workspace_id: workspace.id });
    await expect(repository.insert(operation('different'))).rejects.toMatchObject({ code: '23505' });
    await repository.update({ id: existing.id }, { status: 'succeeded' });
    await expect(repository.insert(operation('same'))).rejects.toMatchObject({ code: '23505' });
    await expect(repository.insert(operation('different'))).resolves.toBeDefined();
  });

  it('hides encrypted credentials from default reads and retains the operation across repository instances', async () => {
    const value = operation('credential'); value.credential = 'test-encrypted-value';
    await source.getRepository(McpPilotOperation).insert(value);
    const ordinary = await source.getRepository(McpPilotOperation).findOneByOrFail({ id: value.id });
    expect(ordinary.credential).toBeUndefined();
    const privileged = await source.getRepository(McpPilotOperation).createQueryBuilder('operation').addSelect('operation.credential').where('operation.id = :id', { id: value.id })
      .getOneOrFail();
    expect(privileged.credential).toBe('test-encrypted-value');
  });
});
