import { Module } from '@nestjs/common';
import { PlannerService } from './planner.service';
import { SkillsModule } from '../skills/skills.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SkillsModule, SettingsModule],
  providers: [PlannerService],
  exports: [PlannerService],
})
export class PlannerModule {}
