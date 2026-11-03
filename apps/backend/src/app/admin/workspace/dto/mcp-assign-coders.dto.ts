import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Min
} from 'class-validator';

import { McpManualJobDto } from './mcp-manual-job.dto';

export class McpAssignCodersDto extends McpManualJobDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  assignedCoders!: number[];
}
