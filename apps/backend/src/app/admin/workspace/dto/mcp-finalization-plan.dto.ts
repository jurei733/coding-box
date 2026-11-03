import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, Matches
} from 'class-validator';

export class McpFinalizationPlanDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^[A-Za-z0-9_.-]{1,100}$/, { each: true })
  groups!: string[];
}
