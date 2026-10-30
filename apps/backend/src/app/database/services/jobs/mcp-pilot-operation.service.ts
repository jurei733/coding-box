import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
  ServiceUnavailableException, UnauthorizedException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import {
  McpPilotKind, McpPilotOperation, McpPilotStatus, McpPilotStatistics,
  McpPilotImportPayload as ImportPayload, McpPilotCodingPayload as CodingPayload
} from '../../entities/mcp-pilot-operation.entity';
import User from '../../entities/user.entity';
import WorkspaceUser from '../../entities/workspace_user.entity';
import Persons from '../../entities/persons.entity';
import { JobQueueService } from '../../../job-queue/job-queue.service';
import { TestcenterService, withStrictTestcenterTransport } from '../test-results/testcenter.service';
import { CodingProcessService } from '../coding/coding-process.service';
import { AutoCodingRunGuardService } from '../coding/auto-coding-run-guard.service';
import { McpPilotConfigService } from './mcp-pilot-config.service';
import {
  StartMcpAutocodingDto, StartMcpTestcenterImportDto
} from '../../../admin/workspace/dto/mcp-pilot-request.dto';
import { ImportOptionsDto, ImportResultDto } from '../../../../../../../api-dto/files/import-options.dto';

const TERMINAL = new Set<McpPilotStatus>(['succeeded', 'failed', 'needs_attention']);

function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

@Injectable()
export class McpPilotOperationService {
  constructor(
    @InjectRepository(McpPilotOperation)
    private readonly operations: Repository<McpPilotOperation>,
    private readonly connection: DataSource,
    private readonly config: McpPilotConfigService,
    private readonly queues: JobQueueService,
    private readonly testcenter: TestcenterService,
    private readonly coding: CodingProcessService,
    private readonly codingGuard: AutoCodingRunGuardService
  ) {}

  private async assertAccess(actorId: number, workspaceId: number): Promise<void> {
    if (!Number.isSafeInteger(actorId) || actorId < 1) throw new UnauthorizedException();
    const actor = await this.connection.getRepository(User).findOne({
      where: { id: actorId }, select: { id: true, isAdmin: true }
    });
    if (!actor) throw new ForbiddenException();
    if (actor.isAdmin) return;
    const membership = await this.connection.getRepository(WorkspaceUser).findOneBy({ userId: actorId, workspaceId });
    if (!membership || membership.accessLevel < 3) throw new ForbiddenException('Study-manager access required.');
  }

  private credentialContext(operation: McpPilotOperation): string {
    return JSON.stringify([operation.id, operation.actor_id, operation.workspace_id,
      'source_url' in operation.payload ? operation.payload.source_url : null]);
  }

  private publicStatus(operation: McpPilotOperation, progress = 0) {
    return {
      operation_id: operation.id,
      ...(operation.kind === 'testcenter-import' ? { import_run_id: operation.id } : { run_id: operation.id }),
      status: operation.status,
      progress: operation.status === 'succeeded' ? 100 : Math.max(0, Math.min(99, Math.floor(progress))),
      statistics: operation.statistics,
      ...(operation.error_code ? {
        error: {
          code: operation.error_code,
          message: operation.status === 'needs_attention' ?
            'Inspect the target and durable import/coding status before creating another request.' :
            'Operation did not complete. Check configuration, rights and source readiness.'
        }
      } : {})
    };
  }

  async startImport(workspaceId: number, actorId: number, body: StartMcpTestcenterImportDto, token: string) {
    this.config.assertEnabled(); await this.assertAccess(actorId, workspaceId);
    if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n]/.test(token)) {
      throw new UnauthorizedException('X-IQB-Testcenter-Token header required.');
    }
    if (!Object.values(body.options).some(value => value === true)) throw new BadRequestException('Select at least one import option.');
    const source = this.config.source(body.server_id, body.tc_workspace_id);
    const payload: ImportPayload = {
      server_id: body.server_id,
      source_url: source.url,
      tc_workspace_id: body.tc_workspace_id,
      groups: [...body.groups].sort(),
      options: { ...body.options },
      response_overwrite_mode: 'skip'
    };
    return this.register('testcenter-import', workspaceId, actorId, body.request_key, payload, token);
  }

  async startCoding(workspaceId: number, actorId: number, body: StartMcpAutocodingDto) {
    this.config.assertEnabled(); await this.assertAccess(actorId, workspaceId);
    const payload: CodingPayload = { auto_coder_run: 1, ...(body.groups ? { groups: [...body.groups].sort() } : {}) };
    return this.register('autocoding', workspaceId, actorId, body.request_key, payload);
  }

  private async register(
    kind: McpPilotKind, workspaceId: number, actorId: number, requestKey: string,
    payload: ImportPayload | CodingPayload, token?: string
  ) {
    const lookup = {
      workspace_id: workspaceId, actor_id: actorId, kind, request_key: requestKey
    };
    const requestHash = fingerprint(payload);
    const existing = await this.operations.findOneBy(lookup);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new ConflictException({ code: 'REQUEST_KEY_CONFLICT' });
      return this.status(workspaceId, actorId, existing.id, kind);
    }
    const operation = this.operations.create({
      id: randomUUID(),
      ...lookup,
      request_hash: requestHash,
      payload,
      status: 'queued',
      credential: null,
      credential_expires_at: null,
      external_job_id: null,
      statistics: null,
      error_code: null
    });
    if (token) {
      operation.credential = this.config.encrypt(token, this.credentialContext(operation));
      operation.credential_expires_at = new Date(Date.now() + 10 * 60_000);
    }
    try { await this.operations.insert(operation); } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505') {
        const previous = await this.operations.findOneBy(lookup);
        if (previous?.request_hash === requestHash) return this.status(workspaceId, actorId, previous.id, kind);
        throw new ConflictException({ code: previous ? 'REQUEST_KEY_CONFLICT' : 'WORKSPACE_OPERATION_ACTIVE' });
      }
      throw new ServiceUnavailableException({ code: 'OPERATION_NOT_REGISTERED' });
    }
    try {
      await this.queues.addMcpPilotJob({ operationId: operation.id, workspaceId, actorId });
    } catch {
      // Queue submission may have succeeded before the transport failed. A queued
      // job may only claim a queued DB record; never re-submit an ambiguous start.
      await this.operations.update({ id: operation.id, status: 'queued' }, {
        status: 'needs_attention',
        credential: null,
        credential_expires_at: null,
        error_code: 'QUEUE_SUBMISSION_UNCERTAIN'
      });
    }
    const current = await this.operations.findOneByOrFail({ id: operation.id });
    return this.publicStatus(current);
  }

  private async finish(operation: McpPilotOperation, status: McpPilotStatus,
                       statistics: McpPilotStatistics | null = null, errorCode: string | null = null) {
    await this.operations.update({ id: operation.id, status: In(['queued', 'running']) }, {
      status, statistics, error_code: errorCode, credential: null, credential_expires_at: null
    });
  }

  private importStatistics(result: ImportResultDto): McpPilotStatistics {
    return {
      persons: result.persons,
      booklets: result.booklets,
      units: result.units,
      test_files: result.testFiles,
      // The legacy result.responses is a task count, not the number of answers.
      import_tasks: result.responses,
      warning_count: result.issues?.filter(issue => issue.level === 'warning').length || 0,
      error_count: result.issues?.filter(issue => issue.level === 'error').length || 0
    };
  }

  private importSucceeded(result: ImportResultDto): boolean {
    return result.success && !result.issues?.some(issue => issue.level === 'error');
  }

  private async syncCoding(operation: McpPilotOperation): Promise<number> {
    if (!operation.external_job_id) return 0;
    const child = await this.queues.getTestPersonCodingJob(operation.external_job_id);
    if (!child || Number(child.data.workspaceId) !== operation.workspace_id) {
      await this.finish(operation, 'needs_attention', null, 'CODING_JOB_UNAVAILABLE'); return 0;
    }
    const state = await child.getState();
    if (state === 'completed') {
      const result = child.returnvalue as { totalResponses?: number; statusCounts?: Record<string, number> };
      await this.finish(operation, 'succeeded', {
        totalResponses: result?.totalResponses ?? 0, statusCounts: result?.statusCounts ?? {}, result_version: 'v1'
      });
    } else if (state === 'failed') {
      await this.finish(operation, 'needs_attention', null, 'CODING_FAILED_CHECK_TARGET');
    }
    const value: unknown = await child.progress();
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  async status(workspaceId: number, actorId: number, id: string, kind: McpPilotKind) {
    await this.assertAccess(actorId, workspaceId);
    let operation = await this.operations.findOneBy({
      id, workspace_id: workspaceId, actor_id: actorId, kind
    });
    if (!operation) throw new NotFoundException();
    let progress = 0;
    if (!TERMINAL.has(operation.status)) {
      if (operation.kind === 'autocoding' && operation.external_job_id) {
        progress = await this.syncCoding(operation);
      } else if (operation.kind === 'testcenter-import' && operation.status === 'running') {
        const native = await this.testcenter.getImportWorkspaceFilesProgress(String(workspaceId), id);
        progress = native.totalPlanned > 0 ? (native.totalProcessed / native.totalPlanned) * 100 : 0;
        if (native.result && native.status !== 'running') {
          const success = this.importSucceeded(native.result);
          await this.finish(operation, success ? 'succeeded' : 'needs_attention', this.importStatistics(native.result), success ? null : 'PARTIAL_IMPORT');
        }
      }
      operation = await this.operations.findOneByOrFail({ id });
      if (!TERMINAL.has(operation.status)) {
        const parent = await this.queues.getMcpPilotJob(id);
        const parentState = parent ? await parent.getState() : undefined;
        if (parentState === 'failed' || parentState === 'completed') {
          await this.finish(operation, 'needs_attention', null, 'WORKER_STOPPED_CHECK_TARGET');
        } else if (!parent && Date.now() - operation.created_at.getTime() > 30_000) {
          await this.finish(operation, 'needs_attention', null, 'QUEUE_JOB_UNAVAILABLE');
        } else if (operation.status === 'queued' && operation.credential_expires_at && operation.credential_expires_at.getTime() < Date.now()) {
          await this.finish(operation, 'failed', null, 'SOURCE_CREDENTIAL_EXPIRED');
        }
      }
      operation = await this.operations.findOneByOrFail({ id });
    }
    return this.publicStatus(operation, progress);
  }

  async execute(id: string): Promise<void> {
    const claim = await this.operations.update({ id, status: 'queued' }, { status: 'running' });
    if (!claim.affected) return; // Bull redelivery must never repeat application mutations.
    const operation = await this.operations.createQueryBuilder('operation')
      .addSelect('operation.credential').where('operation.id = :id', { id }).getOne();
    if (!operation) return;
    let mutationsMayHaveStarted = false;
    try {
      this.config.assertEnabled(); await this.assertAccess(operation.actor_id, operation.workspace_id);
      if (operation.kind === 'testcenter-import') {
        const payload = operation.payload as ImportPayload;
        const source = this.config.source(payload.server_id, payload.tc_workspace_id);
        if (source.url !== payload.source_url) throw new BadRequestException('Source configuration changed.');
        if (!operation.credential || !operation.credential_expires_at || operation.credential_expires_at.getTime() < Date.now()) {
          await this.finish(operation, 'failed', null, 'SOURCE_CREDENTIAL_EXPIRED'); return;
        }
        const token = this.config.decrypt(operation.credential, this.credentialContext(operation));
        // Delete the persisted credential before the first upstream request.
        await this.operations.update({ id }, { credential: null, credential_expires_at: null });
        const options = Object.fromEntries(Object.entries(payload.options).map(([key, value]) => [key, value ? 'true' : 'false'])) as unknown as ImportOptionsDto;
        mutationsMayHaveStarted = true;
        const result = await withStrictTestcenterTransport(() => this.testcenter.importWorkspaceFiles(
          String(operation.workspace_id), String(payload.tc_workspace_id), payload.server_id, source.url, token, options, payload.groups.join(','), false, undefined, id, 'skip', operation.actor_id
        ));
        const success = this.importSucceeded(result);
        await this.finish(operation, success ? 'succeeded' : 'needs_attention', this.importStatistics(result), success ? null : 'PARTIAL_IMPORT');
      } else {
        const payload = operation.payload as CodingPayload;
        const people = await this.connection.getRepository(Persons).find({
          where: { workspace_id: operation.workspace_id, consider: true, ...(payload.groups ? { group: In(payload.groups) } : {}) }, select: { id: true }
        });
        if (!people.length) { await this.finish(operation, 'failed', null, 'NO_CONSIDERED_PERSONS'); return; }
        await this.queues.assertNoDependencyConflicts('test-person-coding', operation.workspace_id);
        await this.codingGuard.assertAutoCodingRunCanStart(operation.workspace_id, 1);
        mutationsMayHaveStarted = true;
        const result = await this.coding.codeTestPersons(operation.workspace_id, people.map(person => String(person.id)).join(','), 1);
        if (!result.jobId) { await this.finish(operation, 'needs_attention', null, 'CODING_JOB_NOT_REGISTERED'); return; }
        await this.operations.update({ id }, { external_job_id: result.jobId });
        operation.external_job_id = result.jobId;
        const child = await this.queues.getTestPersonCodingJob(result.jobId);
        if (!child) { await this.finish(operation, 'needs_attention', null, 'CODING_JOB_UNAVAILABLE'); return; }
        await child.finished();
        await this.syncCoding(operation);
      }
    } catch {
      // Never persist Axios errors, source tokens, raw answers or exception messages.
      await this.finish(operation, mutationsMayHaveStarted ? 'needs_attention' : 'failed', null, mutationsMayHaveStarted ? 'OPERATION_INTERRUPTED_CHECK_TARGET' : 'PREFLIGHT_FAILED');
    }
  }
}
