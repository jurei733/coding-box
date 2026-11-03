import { testcenterSourceSelection } from './testcenter-source-selection.util';

describe('MCP Testcenter source selection', () => {
  const files = [{ name: 'G8.xml' }, { name: 'G8.vocs' }, { name: 'G8.vomd' }, { name: 'OTHER.xml' }];
  it('preserves legacy imports and selects the exact study companion files without unrelated studies', () => {
    expect(testcenterSourceSelection(files)).toBeUndefined();
    const selected = testcenterSourceSelection(files, ['g8.XML', 'G8.vocs', 'G8.vomd']);
    expect(files.filter(file => selected.has(file.name.toUpperCase())).map(file => file.name)).toEqual(['G8.xml', 'G8.vocs', 'G8.vomd']);
  });
  it.each([[], ['missing.xml'], ['G8.xml', 'g8.XML'], ['../G8.xml']].map(requested => ({ requested })))('rejects an invalid selection before accepting missing files: %j', ({ requested }) => {
    expect(() => testcenterSourceSelection(files, requested)).toThrow();
  });
});
