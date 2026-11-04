import {
  Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards, ValidationPipe
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { McpManualCaseService } from '../../database/services/coding/mcp-manual-case.service';
import { CodingJobService } from '../../database/services/coding/coding-job.service';

import { CodingJobMutationService } from '../../database/services/coding/coding-job-mutation.service';

import { McpManualJobDto } from './dto/mcp-manual-job.dto';

@ApiTags('MCP Manual Coding')
@ApiBearerAuth()
@Controller('wsg-admin/workspace/:workspace_id/coding-job')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class WorkspaceMcpManualController {
  constructor(private readonly cases: McpManualCaseService, private readonly jobs: CodingJobService, private readonly mutation: CodingJobMutationService) {}

  @Get(':job_id/mcp-state')
  @ApiOperation({ summary: 'Read assigned job and revision covering decisions, answers and rubrics' })
  state(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number, @Req() request: { user: { id: number } }) {
    return this.cases.state(workspace, job, request.user.id);
  }

  @Post(':job_id/mcp-submit')
  @ApiOperation({ summary: 'Submit with an atomic approved job revision' })
  async submit(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number,
    @Req() request: { user: { id: number } }, @Body(new ValidationPipe({ whitelist: true, transform: true })) body: McpManualJobDto) {
    const state = await this.cases.state(workspace, job, request.user.id);
    await this.mutation.updateCodingJob(job, workspace, { status: (state.requires_review || body.reviewRequested) ? 'review' : 'completed' }, request.user.id, true, body.expectedRevision);
    return this.cases.state(workspace, job, request.user.id);
  }

  @Get(':job_id/mcp-case/:response_id')
  @ApiOperation({ summary: 'Read an assigned manual case, rubric and atomic revision' })
  @ApiOkResponse({ description: 'Contains source answer, native rubric, saved decision and revision; no replay token.' })
  async get(
    @Param('workspace_id', ParseIntPipe) workspace: number,
    @Param('job_id', ParseIntPipe) job: number,
    @Param('response_id', ParseIntPipe) response: number,
    @Req() request: { user: { id: number } }
  ) {
    return this.cases.get(workspace, job, response, request.user.id);
  }
}
