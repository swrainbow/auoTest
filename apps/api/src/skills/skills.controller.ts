import { BadRequestException, Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { SkillsService } from './skills.service';
import type { SkillDto, SaveSkillFileInput } from '@autotest/shared';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  async list(): Promise<SkillDto[]> {
    return this.skills.list();
  }

  @Get('file')
  async read(@Query('path') filePath: string): Promise<{ path: string; content: string }> {
    if (!filePath) throw new BadRequestException('缺少 path 参数');
    return this.skills.read(filePath);
  }

  @Put('file')
  async save(@Body() body: SaveSkillFileInput): Promise<{ path: string }> {
    return this.skills.write(body.path, body.content ?? '', false);
  }

  @Post('file')
  async create(@Body() body: SaveSkillFileInput): Promise<{ path: string }> {
    return this.skills.write(body.path, body.content ?? '', true);
  }

  @Delete('file')
  async remove(@Query('path') filePath: string): Promise<{ ok: true }> {
    if (!filePath) throw new BadRequestException('缺少 path 参数');
    return this.skills.remove(filePath);
  }

  @Post('directory')
  async createSkill(@Body() body: { dir: string }): Promise<SkillDto['files']> {
    return this.skills.createSkill(body?.dir ?? '');
  }
}
