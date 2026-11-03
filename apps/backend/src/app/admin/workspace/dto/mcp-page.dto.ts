import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt, IsOptional, Max, Min
} from 'class-validator';
import { Type } from 'class-transformer';

export class McpPageDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}
