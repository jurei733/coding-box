import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags
} from '@nestjs/swagger';
import { unlink } from 'fs/promises';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorkspaceGuard } from '../workspace/workspace.guard';
import {
  AccessLevelGuard,
  RequireAccessLevel
} from '../workspace/access-level.guard';
import { DatabaseImportService } from './database-import.service';

@Controller('admin/workspace')
@ApiTags('workspace')
export class DatabaseImportController {
  constructor(private readonly service: DatabaseImportService) {}

  @Post(':workspace_id/import/sqlite')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Restore a native SQLite workspace snapshot into an empty workspace'
  })
  @UseGuards(JwtAuthGuard, WorkspaceGuard, AccessLevelGuard)
  @RequireAccessLevel(3)
  @UseInterceptors(
    FileInterceptor('file', {
      dest: '/tmp',
      limits: { fileSize: 64 * 1024 * 1024, files: 1 }
    })
  )
  async importSnapshot(
    @Param('workspace_id', ParseIntPipe) workspace: number,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: { id: number } },
    @Body('userMap') serializedUserMap?: string
  ) {
    if (!file) throw new BadRequestException('A snapshot file is required.');
    try {
      let userMap: Record<string, number> = {};
      try {
        userMap = JSON.parse(serializedUserMap || '{}');
        if (
          !userMap ||
          Array.isArray(userMap) ||
          typeof userMap !== 'object' ||
          Object.keys(userMap).length > 100 ||
          Object.entries(userMap).some(
            ([key, value]) => !/^[1-9][0-9]*$/.test(key) ||
              !Number.isSafeInteger(value) ||
              value < 1
          )
        ) throw new Error('invalid');
      } catch {
        throw new BadRequestException(
          'userMap must map source user IDs to target user IDs.'
        );
      }
      return await this.service.importWorkspace(
        file.path,
        workspace,
        Number(req.user.id),
        userMap
      );
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }
}
