import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CasesService } from './cases.service';
import { ScriptGenerationsService } from './script-generations.service';
import { PlannerService } from '../planner/planner.service';
import type { SaveTestCaseInput, TestCaseDto } from '@autotest/shared';

@Controller('test-cases')
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly planner: PlannerService,
    private readonly generations: ScriptGenerationsService,
  ) {}

  @Get()
  async list(): Promise<TestCaseDto[]> {
    return this.cases.list();
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.cases.get(id);
  }

  @Post()
  async create(@Body() body: SaveTestCaseInput): Promise<TestCaseDto> {
    return this.cases.create(body);
  }

  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: SaveTestCaseInput & { changeNote?: string }) {
    return this.cases.update(id, body);
  }

  @Put(':id/status')
  async updateStatus(@Param('id', ParseIntPipe) id: number, @Body() body: { status: string }) {
    return this.cases.updateStatus(id, body?.status ?? '');
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.cases.remove(id);
  }

  /** 自然语言 → 测试计划草稿（不落库，确认后再 POST 创建） */
  @Post('generate')
  async generate(@Body() body: { requirement: string; skill?: string; taskId?: string }) {
    return this.planner.generatePlan(body?.requirement ?? '', body?.skill, body?.taskId);
  }

  @Post(':id/generate-script')
  @HttpCode(HttpStatus.ACCEPTED)
  async generateScript(@Param('id', ParseIntPipe) id: number, @Body('version') version?: number) {
    return this.generations.enqueue(id, version);
  }

  @Get(':id/script-generation')
  async scriptGeneration(@Param('id', ParseIntPipe) id: number, @Res() response: Response) {
    response.json(await this.generations.latest(id));
  }

  /** 查看当前脚本内容 */
  @Get(':id/script')
  async readScript(@Param('id', ParseIntPipe) id: number, @Query('version') version?: string) {
    return this.cases.readScript(id, version === undefined ? undefined : Number(version));
  }
}
