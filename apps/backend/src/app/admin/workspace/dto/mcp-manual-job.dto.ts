import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean, IsOptional, IsString, Matches
} from 'class-validator';

export class McpManualJobDto {
  @ApiProperty({ description: 'Atomic job revision returned by mcp-state' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedRevision!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  overwriteExisting?: boolean;
}
