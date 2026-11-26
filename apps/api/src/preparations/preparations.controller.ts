import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { PreparationsService } from './preparations.service';

@Controller('preparations')
export class PreparationsController {
  constructor(private readonly preparations: PreparationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  workspace() {
    return this.preparations.workspace();
  }

  @Post('rules')
  saveRule(@Body() body: Parameters<PreparationsService['saveRule']>[0]) {
    return this.preparations.saveRule(body ?? {});
  }

  @Post('flows')
  saveFlow(@Body() body: Parameters<PreparationsService['saveFlow']>[0]) {
    return this.preparations.saveFlow(body ?? {});
  }

  @Post('runs')
  run(@Body() body: Parameters<PreparationsService['enqueue']>[0]) {
    return this.preparations.enqueue(body ?? {});
  }

  @Get('runs/:id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string) {
    return this.preparations.get(id);
  }
}
