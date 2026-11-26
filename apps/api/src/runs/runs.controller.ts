import { BadRequestException, Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { RunsService } from './runs.service';
import type { CreateRunInput } from '@autotest/shared';

@Controller('test-runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  async list(@Query('status') status?: string) {
    return this.runs.list(status);
  }

  @Get('page')
  async listPage(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(10), ParseIntPipe) pageSize: number,
    @Query('status') status?: string,
    @Query('module') module?: string,
    @Query('testCaseId', new ParseIntPipe({ optional: true })) testCaseId?: number,
  ) {
    if ((status !== undefined && typeof status !== 'string') || (module !== undefined && typeof module !== 'string')) {
      throw new BadRequestException('筛选参数无效');
    }
    return this.runs.listPage({
      page: Math.max(1, page),
      pageSize: Math.min(100, Math.max(1, pageSize)),
      status,
      module,
      testCaseId,
    });
  }

  @Post()
  async create(@Body() body: CreateRunInput) {
    return this.runs.create(body ?? { mode: 'explore' });
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.runs.get(id);
  }

  @Get(':id/log')
  async log(@Param('id', ParseIntPipe) id: number, @Query('tail') tail?: string) {
    const lines = Math.min(Math.max(Number(tail) || 400, 1), 2000);
    return { log: await this.runs.readLogTail(id, lines) };
  }

  @Get(':id/artifacts')
  async artifacts(@Param('id', ParseIntPipe) id: number) {
    return { files: await this.runs.listArtifacts(id) };
  }

  @Post(':id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number) {
    return this.runs.cancel(id);
  }

  /** AI 失败诊断 */
  @Post(':id/diagnose')
  async diagnose(@Param('id', ParseIntPipe) id: number) {
    return this.runs.diagnose(id);
  }

  @Post(':id/repair')
  async repair(@Param('id', ParseIntPipe) id: number) {
    return this.runs.repair(id);
  }
}
