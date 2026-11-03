import {
  Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards, ValidationPipe
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { McpManualCaseService } from '../../database/services/coding/mcp-manual-case.service';
import { CodingJobService } from '../../database/services/coding/coding-job.service';
import { CodingJobOperationsService } from '../../database/services/coding/coding-job-operations.service';
import { CodingJobMutationService } from '../../database/services/coding/coding-job-mutation.service';
import { AccessLevelGuard, RequireAccessLevel } from './access-level.guard';
import { McpManualJobDto } from './dto/mcp-manual-job.dto';
import { McpFinalizationPlanDto } from './dto/mcp-finalization-plan.dto';
import { McpAssignCodersDto } from './dto/mcp-assign-coders.dto';
import { McpReviewDecisionDto } from './dto/mcp-review-decision.dto';
import { McpPageDto } from './dto/mcp-page.dto';

@ApiTags('MCP Manual Coding')
@ApiBearerAuth()
@Controller('admin/workspace/:workspace_id/coding/jobs')
@UseGuards(JwtAuthGuard, WorkspaceGuard, AccessLevelGuard)
@RequireAccessLevel(3)
export class WorkspaceMcpManualAdminController {
  constructor(private readonly cases: McpManualCaseService, private readonly operations: CodingJobOperationsService, private readonly mutation: CodingJobMutationService, private readonly jobs: CodingJobService) {}

  @Get(':job_id/mcp-review-cases')
  @ApiOperation({ summary: 'List problem cases for native supervisor review' })
  reviews(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) page: McpPageDto) {
    return this.cases.reviews(workspace, job, page.page, page.limit);
  }

  @Get(':job_id/mcp-review/:response_id')
  @ApiOperation({ summary: 'Read original answer, rubric and own supervisor decision with revision' })
  review(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number,
    @Param('response_id', ParseIntPipe) response: number, @Req() request: { user: { id: number } }) {
    return this.cases.review(workspace, job, response, request.user.id);
  }

  @Post(':job_id/mcp-review/:response_id')
  @ApiOperation({ summary: 'Save a native supervisor decision with atomic source and decision revision' })
  async saveReview(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number,
    @Param('response_id', ParseIntPipe) response: number, @Req() request: { user: { id: number } },
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: McpReviewDecisionDto) {
    const source = await this.cases.review(workspace, job, response, request.user.id);
    await this.jobs.saveCodingIssueReviewProgress(job, request.user.id, {
      testPerson: source.test_person,
      unitId: source.unit_name,
      variableId: source.variable_id,
      selectedCode: { id: body.code },
      isOpen: false,
      notes: body.notes,
      expectedRevision: body.expectedRevision,
      issueReview: true
    });
    return this.cases.review(workspace, job, response, request.user.id);
  }

  @Post('mcp-finalization-plan')
  @ApiOperation({ summary: 'Inspect explicitly selected groups before native final coding run 2' })
  finalization(@Param('workspace_id', ParseIntPipe) workspace: number,
    @Body(new ValidationPipe({ whitelist: true, transform: true })) body: McpFinalizationPlanDto) {
    return this.cases.finalization(workspace, body.groups);
  }

  @Post(':job_id/mcp-assign')
  @ApiOperation({ summary: 'Assign coders under native ownership rules and an atomic revision' })
  async assign(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number,
    @Req() request: { user: { id: number } }, @Body(new ValidationPipe({ whitelist: true, transform: true })) body: McpAssignCodersDto) {
    await this.mutation.updateCodingJob(job, workspace, { assignedCoders: body.assignedCoders }, request.user.id, false, body.expectedRevision);
    return this.cases.state(workspace, job, request.user.id, true);
  }

  @Get(':job_id/mcp-state')
  @ApiOperation({ summary: 'Read administrator job revision without impersonating an assigned coder' })
  state(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number, @Req() request: { user: { id: number } }) {
    return this.cases.state(workspace, job, request.user.id, true);
  }

  @Post(':job_id/mcp-apply')
  @ApiOperation({ summary: 'Apply native v2 decisions with revision checked inside the write transaction' })
  apply(@Param('workspace_id', ParseIntPipe) workspace: number, @Param('job_id', ParseIntPipe) job: number,
    @Req() request: { user: { id: number } }, @Body(new ValidationPipe({ whitelist: true, transform: true })) body: McpManualJobDto) {
    return this.operations.applyCodingResults(workspace, job, { overwriteExisting: body.overwriteExisting === true, expectedRevision: body.expectedRevision, actorUserId: request.user.id });
  }
}
