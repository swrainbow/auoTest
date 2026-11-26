import { Body, Controller, Get, Header, Put } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PlatformSettings, UpdateSettingsInput } from '@autotest/shared';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(): Promise<PlatformSettings> {
    return this.settings.get();
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  async update(@Body() body: UpdateSettingsInput): Promise<PlatformSettings> {
    return this.settings.update(body ?? {});
  }
}
