import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { PreparationRunner } from './preparation-runner';
import { PreparationsController } from './preparations.controller';
import { PreparationsService } from './preparations.service';

@Module({
  imports: [SettingsModule],
  providers: [PreparationsService, PreparationRunner],
  controllers: [PreparationsController],
})
export class PreparationsModule {}
