import { Module } from '@nestjs/common';
import { RunsService } from './runs.service';
import { RunsController } from './runs.controller';
import { SettingsModule } from '../settings/settings.module';
import { PlannerModule } from '../planner/planner.module';
import { CasesModule } from '../cases/cases.module';
import { SkillsModule } from '../skills/skills.module';

@Module({
  imports: [SettingsModule, PlannerModule, CasesModule, SkillsModule],
  providers: [RunsService],
  controllers: [RunsController],
})
export class RunsModule {}
