import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { WorkspaceMcpManualController } from './workspace-mcp-manual.controller';
import { McpManualJobDto } from './dto/mcp-manual-job.dto';

describe('MCP manual submission mode', () => {
  const revision = 'a'.repeat(64);

  it.each([
    [false, false, 'completed'],
    [true, false, 'review'],
    [false, true, 'review']
  ])('requires_review=%s explicit_review=%s uses %s and the approved atomic revision', async (flagged, explicit, status) => {
    const cases = { state: jest.fn().mockResolvedValue({ requires_review: flagged }) };
    const mutation = { updateCodingJob: jest.fn().mockResolvedValue({}) };
    const controller = new WorkspaceMcpManualController(cases as never, {} as never, mutation as never);
    await controller.submit(16, 18, { user: { id: 7 } }, { expectedRevision: revision, reviewRequested: explicit });
    expect(mutation.updateCodingJob).toHaveBeenCalledWith(18, 16, { status }, 7, true, revision);
  });

  it('requires a real boolean review request and retains the mandatory revision', () => {
    expect(validateSync(Object.assign(new McpManualJobDto(), { expectedRevision: revision, reviewRequested: true }))).toHaveLength(0);
    expect(validateSync(Object.assign(new McpManualJobDto(), { expectedRevision: revision, reviewRequested: 'true' })).some(error => error.property === 'reviewRequested')).toBe(true);
    expect(validateSync(Object.assign(new McpManualJobDto(), { reviewRequested: true })).some(error => error.property === 'expectedRevision')).toBe(true);
  });
});
