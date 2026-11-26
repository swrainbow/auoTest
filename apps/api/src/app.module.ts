import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { PathsModule } from './paths/paths.module';
import { SettingsModule } from './settings/settings.module';
import { SkillsModule } from './skills/skills.module';
import { PlannerModule } from './planner/planner.module';
import { CasesModule } from './cases/cases.module';
import { RunsModule } from './runs/runs.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PreparationsModule } from './preparations/preparations.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    PrismaModule,
    PathsModule,
    SettingsModule,
    SkillsModule,
    PlannerModule,
    CasesModule,
    RunsModule,
    DashboardModule,
    PreparationsModule,
  ],
})
export class AppModule {}
