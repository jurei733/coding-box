import {
  Controller, Get, Param, ParseIntPipe, Req, UseGuards
} from '@nestjs/common';
import {
  ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { McpManualCaseService } from '../../database/services/coding/mcp-manual-case.service';

@ApiTags('MCP Manual Coding')
@ApiBearerAuth()
@Controller('wsg-admin/workspace/:workspace_id/coding-job')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class WorkspaceMcpManualController {
  constructor(private readonly cases: McpManualCaseService) {}

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
