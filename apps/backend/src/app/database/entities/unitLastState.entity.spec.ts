import {
  DataSource, EntitySchema, EntitySchemaOptions, getMetadataArgsStorage
} from 'typeorm';
import { RawSqlResultsToEntityTransformer } from 'typeorm/query-builder/transformer/RawSqlResultsToEntityTransformer';
import { UnitLastState } from './unitLastState.entity';

class MetadataDataSource extends DataSource {
  async prepareMetadata(): Promise<void> {
    await this.buildMetadatas();
  }
}

describe('Unit last-state result hydration', () => {
  async function nativeProjection() {
    // Use the production scalar decorators and real TypeORM PostgreSQL result
    // hydration. Relation graphs are irrelevant here; no database is contacted.
    const columns = Object.fromEntries(getMetadataArgsStorage().columns
      .filter(column => column.target === UnitLastState)
      .map(column => [column.propertyName, { ...column.options }])) as EntitySchemaOptions<UnitLastState>['columns'];
    const schema = new EntitySchema<UnitLastState>({
      name: 'UnitLastStateHydrationProbe', tableName: 'unitlaststate', columns
    });
    const source = new MetadataDataSource({
      type: 'postgres', database: 'unitlaststate_hydration_test', entities: [schema]
    });
    await source.prepareMetadata();
    const query = source.getRepository(schema).createQueryBuilder('laststate')
      .select(['laststate.unitid', 'laststate.key', 'laststate.value']);
    // getMany uses entity hydration and adds missing identity columns to SQL.
    query.expressionMap.queryEntity = true;
    return { source, query };
  }

  it('preserves distinct state keys for the same unit when hydrating an export projection', async () => {
    const { source, query } = await nativeProjection();
    const transformer = new RawSqlResultsToEntityTransformer(
      query.expressionMap, source.driver, [], []
    );
    const rows = transformer.transform([
      {
        laststate_id: 71, laststate_unitid: '41', laststate_key: 'CURRENT_PAGE_ID', laststate_value: 'page-2'
      },
      {
        laststate_id: 72, laststate_unitid: '41', laststate_key: 'RESPONSE_PROGRESS', laststate_value: 'complete'
      },
      {
        laststate_id: 73, laststate_unitid: '42', laststate_key: 'RESPONSE_PROGRESS', laststate_value: 'none'
      }
    ], query.expressionMap.mainAlias!) as UnitLastState[];

    expect(rows.map(row => ({ unitid: String(row.unitid), key: row.key, value: row.value }))).toEqual([
      { unitid: '41', key: 'CURRENT_PAGE_ID', value: 'page-2' },
      { unitid: '41', key: 'RESPONSE_PROGRESS', value: 'complete' },
      { unitid: '42', key: 'RESPONSE_PROGRESS', value: 'none' }
    ]);
  });

  it('selects the existing row identifier when the caller requests only state fields', async () => {
    const { source, query } = await nativeProjection();
    expect(source.getMetadata('UnitLastStateHydrationProbe').primaryColumns.map(column => column.propertyName)).toEqual(['id']);
    expect(query.getQuery()).toContain('"laststate"."id" AS "laststate_id"');
  });
});
