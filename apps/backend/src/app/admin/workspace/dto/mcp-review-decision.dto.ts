import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt, IsString, MaxLength, Min, MinLength
} from 'class-validator';

import { McpManualJobDto } from './mcp-manual-job.dto';

export class McpReviewDecisionDto extends McpManualJobDto {
  @ApiProperty({ description: 'Regular schema code; points are resolved natively' })
  @IsInt()
  @Min(0)
  code!: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  notes!: string;
}
