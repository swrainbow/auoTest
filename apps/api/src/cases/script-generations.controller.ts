import { Controller, Get } from '@nestjs/common';
import { ScriptGenerationsService } from './script-generations.service';

@Controller('script-generations')
export class ScriptGenerationsController {
  constructor(private readonly generations: ScriptGenerationsService) {}

  @Get()
  list() {
    return this.generations.list();
  }
}
