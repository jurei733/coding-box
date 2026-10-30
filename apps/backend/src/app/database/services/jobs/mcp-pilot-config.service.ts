import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type Source = { url: string; workspace_ids: number[] };

@Injectable()
export class McpPilotConfigService {
  constructor(private readonly config: ConfigService) {}

  assertEnabled(): void {
    if (this.config.get<string>('MCP_PILOT_ENABLED') !== 'true') {
      throw new ServiceUnavailableException({ code: 'MCP_PILOT_DISABLED', message: 'MCP pilot endpoints are disabled.' });
    }
  }

  private key(): Buffer {
    const value = this.config.get<string>('MCP_PILOT_CREDENTIAL_KEY') || '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32) {
      throw new ServiceUnavailableException({ code: 'MCP_PILOT_CONFIG_INVALID', message: 'MCP_PILOT_CREDENTIAL_KEY must encode 32 random bytes.' });
    }
    return Buffer.from(value, 'base64');
  }

  source(id: string, workspaceId: number): Source {
    this.assertEnabled();
    try {
      const sources: unknown = JSON.parse(this.config.get<string>('MCP_PILOT_TESTCENTERS') || '{}');
      const source = sources && typeof sources === 'object' && !Array.isArray(sources) &&
        Object.prototype.hasOwnProperty.call(sources, id) ? (sources as Record<string, unknown>)[id] : undefined;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error();
      const { url, workspace_ids: workspaceIds } = source as Record<string, unknown>;
      if (typeof url !== 'string' || !Array.isArray(workspaceIds) || !workspaceIds.length ||
        !workspaceIds.every(value => Number.isSafeInteger(value) && value > 0) || !workspaceIds.includes(workspaceId)) throw new Error();
      const parsed = new URL(url);
      const localHttp = this.config.get<string>('MCP_PILOT_ALLOW_LOCAL_HTTP') === 'true' &&
        parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
      if ((!localHttp && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash || /\/api\/?$/.test(parsed.pathname)) throw new Error();
      return { url: url.replace(/\/$/, ''), workspace_ids: workspaceIds as number[] };
    } catch {
      throw new ServiceUnavailableException({ code: 'MCP_SOURCE_NOT_ALLOWED', message: 'Testcenter source and workspace must be configured in MCP_PILOT_TESTCENTERS (URL without /api).' });
    }
  }

  encrypt(token: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
  }

  decrypt(credential: string, context: string): string {
    const [iv, tag, encrypted] = credential.split('.').map(value => Buffer.from(value, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
