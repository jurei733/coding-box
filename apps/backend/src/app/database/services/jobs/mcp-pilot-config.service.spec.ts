import { ConfigService } from '@nestjs/config';
import { McpPilotConfigService } from './mcp-pilot-config.service';

function config(url = 'https://tc.example.org', extra: Record<string, string> = {}) {
  return new McpPilotConfigService(new ConfigService({
    MCP_PILOT_ENABLED: 'true',
    MCP_PILOT_CREDENTIAL_KEY: Buffer.alloc(32, 8).toString('base64'),
    MCP_PILOT_TESTCENTERS: JSON.stringify({ pilot: { url, workspace_ids: [42] } }),
    ...extra
  }));
}

describe('MCP pilot source configuration', () => {
  it('limits source IDs, workspaces and URL forms', () => {
    expect(config().source('pilot', 42).url).toBe('https://tc.example.org');
    expect(() => config().source('pilot', 99)).toThrow();
    expect(() => config().source('other', 42)).toThrow();
    for (const url of ['http://remote.example.org', 'https://u:p@tc.example.org', 'https://tc.example.org/api', 'https://tc.example.org/?token=x', 'https://tc.example.org/#fragment']) {
      expect(() => config(url).source('pilot', 42)).toThrow();
    }
    expect(() => config('http://127.0.0.1:4200').source('pilot', 42)).toThrow();
    expect(config('http://127.0.0.1:4200', { MCP_PILOT_ALLOW_LOCAL_HTTP: 'true' }).source('pilot', 42).url).toBe('http://127.0.0.1:4200');
  });

  it('authenticates encrypted credentials against the operation context', () => {
    const service = config(); const encrypted = service.encrypt('source-token', 'operation-and-owner');
    expect(encrypted).not.toContain('source-token'); expect(service.decrypt(encrypted, 'operation-and-owner')).toBe('source-token');
    expect(() => service.decrypt(encrypted, 'another-owner')).toThrow();
    expect(() => config(undefined, { MCP_PILOT_CREDENTIAL_KEY: '' }).encrypt('token', 'context')).toThrow();
    expect(() => config(undefined, { MCP_PILOT_ENABLED: 'false' }).assertEnabled()).toThrow();
  });
});
