import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe,
  Post, Req, UseGuards, ValidationPipe
} from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBearerAuth, ApiConflictResponse, ApiHeader, ApiOkResponse,
  ApiOperation, ApiParam, ApiTags
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from './workspace.guard';
import { AccessLevelGuard, RequireAccessLevel } from './access-level.guard';
import { McpPilotOperationService } from '../../database/services/jobs/mcp-pilot-operation.service';
import { StartMcpAutocodingDto, StartMcpTestcenterImportDto } from './dto/mcp-pilot-request.dto';
import { McpPilotStatusDto } from './dto/mcp-pilot-status.dto';

type ActorRequest = { user: { id: number } };
const bodyValidation = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

@ApiTags('MCP Pilot')
@ApiBearerAuth()
@ApiParam({ name: 'workspace_id', type: Number })
@UseGuards(JwtAuthGuard, WorkspaceGuard, AccessLevelGuard)
@RequireAccessLevel(3)
@Controller('admin/workspace/:workspace_id')
export class WorkspaceMcpPilotController {
  constructor(private readonly operations: McpPilotOperationService) {}

  @Post('testcenter-imports')
  @HttpCode(202)
  @ApiOperation({ summary: 'Start an idempotent Testcenter import for this user and workspace' })
  @ApiHeader({ name: 'X-IQB-Testcenter-Token', required: true, description: 'Source session; exclude from logs and traces.' })
  @ApiAcceptedResponse({ type: McpPilotStatusDto, description: 'Durable operation status, including import_run_id.' })
  @ApiConflictResponse({ description: 'Request key conflict or an active workspace operation.' })
  startImport(
    @Param('workspace_id', ParseIntPipe) workspaceId: number,
    @Req() request: ActorRequest,
    @Body(bodyValidation) body: StartMcpTestcenterImportDto,
    @Headers('x-iqb-testcenter-token') token: string
  ) {
    return this.operations.startImport(workspaceId, request.user.id, body, token);
  }

  @Get('testcenter-imports/:import_run_id')
  @ApiParam({ name: 'import_run_id', type: String })
  @ApiOperation({ summary: 'Read an import owned by the current user in this workspace' })
  @ApiOkResponse({ type: McpPilotStatusDto, description: 'Operation state, progress and sanitized statistics.' })
  importStatus(
    @Param('workspace_id', ParseIntPipe) workspaceId: number,
    @Param('import_run_id', ParseUUIDPipe) id: string,
    @Req() request: ActorRequest
  ) {
    return this.operations.status(workspaceId, request.user.id, id, 'testcenter-import');
  }

  @Post('autocoding-runs')
  @HttpCode(202)
  @ApiOperation({ summary: 'Start a person-scoped, idempotent standard autocoding run' })
  @ApiAcceptedResponse({ type: McpPilotStatusDto, description: 'Durable operation status, including run_id.' })
  @ApiConflictResponse({ description: 'Request key conflict or an active workspace operation.' })
  startCoding(
    @Param('workspace_id', ParseIntPipe) workspaceId: number,
    @Req() request: ActorRequest,
    @Body(bodyValidation) body: StartMcpAutocodingDto
  ) {
    return this.operations.startCoding(workspaceId, request.user.id, body);
  }

  @Get('autocoding-runs/:run_id')
  @ApiParam({ name: 'run_id', type: String })
  @ApiOperation({ summary: 'Read an autocoding run owned by the current user' })
  @ApiOkResponse({ type: McpPilotStatusDto, description: 'Operation state, progress and coding statistics.' })
  codingStatus(
    @Param('workspace_id', ParseIntPipe) workspaceId: number,
    @Param('run_id', ParseUUIDPipe) id: string,
    @Req() request: ActorRequest
  ) {
    return this.operations.status(workspaceId, request.user.id, id, 'autocoding');
  }
}
