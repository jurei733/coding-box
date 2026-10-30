/* eslint-disable max-classes-per-file */
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, Equals, IsArray, IsBoolean, IsDefined,
  IsInt, IsObject, IsString, Matches, MaxLength, Min, ValidateIf, ValidateNested
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class McpImportOptionsDto {
  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  definitions = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  responses = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  player = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  units = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  codings = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  booklets = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  testTakers = true;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  metadata = true;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  logs = false;
}

export class StartMcpTestcenterImportDto {
  @ApiProperty({ example: 'pilot-testcenter' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  server_id!: string;

  @ApiProperty({ example: 42 })
  @IsInt()
  @Min(1)
  tc_workspace_id!: number;

  @ApiProperty({ type: [String], example: ['PILOT01_group'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^[A-Za-z0-9_.-]{1,100}$/, { each: true })
  groups!: string[];

  @ApiProperty({ type: McpImportOptionsDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => McpImportOptionsDto)
  options!: McpImportOptionsDto;

  @ApiProperty({ enum: ['skip'] })
  @Equals('skip')
  response_overwrite_mode!: 'skip';

  @ApiProperty({ example: 'pilot-001-import' })
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,120}$/)
  request_key!: string;
}

export class StartMcpAutocodingDto {
  @ApiProperty({ enum: [1] })
  @Equals(1)
  auto_coder_run!: 1;

  @ApiPropertyOptional({ type: [String], description: 'Omit to process all considered persons of this workspace.' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^[A-Za-z0-9_.-]{1,100}$/, { each: true })
  groups?: string[];

  @ApiProperty({ example: 'pilot-001-coding' })
  @IsString()
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9._:-]{1,120}$/)
  request_key!: string;
}
