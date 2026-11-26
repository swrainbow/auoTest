import { Module } from '@nestjs/common';
import { CasesService } from './cases.service';
import { CasesController } from './cases.controller';
import { ScriptGenerationsController } from './script-generations.controller';
import { ScriptGenerationsService } from './script-generations.service';
import { PlannerModule } from '../planner/planner.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [PlannerModule, SettingsModule],
  providers: [CasesService, ScriptGenerationsService],
  exports: [CasesService],
  controllers: [CasesController, ScriptGenerationsController],
})
export class CasesModule {}
