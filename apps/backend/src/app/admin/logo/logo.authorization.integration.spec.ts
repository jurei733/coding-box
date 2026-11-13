import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogoController } from './logo.controller';
import { LogoService } from './logo.service';
import { LogoUploadInterceptor } from './logo-upload.interceptor';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthService } from '../../auth/service/auth.service';
import { UsersService } from '../../database/services/users';

// These HTTP/filesystem tests exercise the real AdminGuard and multipart
// interceptor. The JWT principal is an explicit fixture; these are not live
// identity-provider acceptance tests.
describe('Logo upload authorization', () => {
  let app: INestApplication;
  let root: string;
  let logoPath: string;
  let url: string;
  let service: LogoService;
  const original = '<svg><!-- existing administrator logo --></svg>';
  const replacement = '<svg><!-- replacement logo --></svg>';

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'logo-authorization-'));
    logoPath = path.join(root, 'apps/frontend/src/assets/images/logo.svg');
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(root);
    service = new LogoService();
    cwd.mockRestore();
    const module = await Test.createTestingModule({
      controllers: [LogoController],
      providers: [
        { provide: LogoService, useValue: service },
        LogoUploadInterceptor,
        { provide: AuthService, useValue: { isAdminUser: async () => false } },
        {
          provide: UsersService,
          useValue: { findUserByIdentity: async () => undefined }
        }
      ]
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          const role = req.headers['x-test-principal'];
          if (!role) throw new UnauthorizedException();
          req.user = {
            userId: 17,
            isAdmin: role === 'system-admin',
            workspaceAccessLevel: role === 'workspace-admin' ? 3 : 0
          };
          return true;
        }
      })
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/admin/logo/upload`;
  });

  beforeEach(async () => {
    await fs.mkdir(path.dirname(logoPath), { recursive: true });
    await fs.writeFile(logoPath, original);
  });

  afterAll(async () => {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  function upload(role?: string, type = 'image/svg+xml') {
    const form = new FormData();
    form.append('logo', new Blob([replacement], { type }), 'custom.svg');
    return fetch(url, {
      method: 'POST',
      headers: role ? { 'x-test-principal': role } : {},
      body: form
    });
  }

  it('allows a system administrator to replace the exact logo bytes', async () => {
    const response = await upload('system-admin');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: 'assets/images/logo.svg' });
    expect(await fs.readFile(logoPath, 'utf8')).toBe(replacement);
  });

  it.each(['unassigned', 'workspace-admin'])(
    'denies %s before multipart storage can overwrite the global logo',
    async role => {
      const uploaded = jest.spyOn(service, 'uploadedLogo');
      try {
        const response = await upload(role);
        expect(response.status).toBe(401);
        expect(uploaded).not.toHaveBeenCalled();
        expect(await fs.readFile(logoPath, 'utf8')).toBe(original);
        expect(await fs.readdir(path.dirname(logoPath))).toEqual(['logo.svg']);
      } finally {
        uploaded.mockRestore();
      }
    }
  );

  it('denies an anonymous request and preserves the existing logo', async () => {
    expect((await upload()).status).toBe(401);
    expect(await fs.readFile(logoPath, 'utf8')).toBe(original);
  });

  it('checks administrator permission before inspecting or storing the file', async () => {
    expect((await upload('unassigned', 'text/plain')).status).toBe(401);
    expect(await fs.readFile(logoPath, 'utf8')).toBe(original);
  });
});
