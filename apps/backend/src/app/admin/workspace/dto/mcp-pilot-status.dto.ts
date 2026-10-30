import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { McpPilotStatistics, McpPilotStatus } from '../../../database/entities/mcp-pilot-operation.entity';

export class McpPilotStatusDto {
  @ApiProperty({ format: 'uuid' })
  operation_id!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  import_run_id?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  run_id?: string;

  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed', 'needs_attention'] })
  status!: McpPilotStatus;

  @ApiProperty({ minimum: 0, maximum: 100 })
  progress!: number;

  @ApiProperty({ type: Object, nullable: true })
  statistics!: McpPilotStatistics | null;

  @ApiPropertyOptional({ type: Object })
  error?: { code: string; message: string };
}
