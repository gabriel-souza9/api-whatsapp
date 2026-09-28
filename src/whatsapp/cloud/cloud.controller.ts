import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { CloudApiProvider } from './cloud-api.provider';
import { MetaApiError } from './meta-errors';

class CloudConfigDto {
  @Matches(/^\d+$/, { message: 'WABA ID deve conter apenas números' })
  wabaId: string;

  @Matches(/^\d+$/, { message: 'Phone Number ID deve conter apenas números' })
  phoneNumberId: string;

  @IsOptional()
  @IsString()
  accessToken?: string;

  @IsOptional()
  @IsString()
  appSecret?: string;
}

@Controller('cloud/:accountId')
export class CloudController {
  constructor(private readonly cloud: CloudApiProvider) {}

  @Get('config')
  getConfig(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.cloud.getConfig(accountId);
  }

  @Put('config')
  saveConfig(@Param('accountId', ParseIntPipe) accountId: number, @Body() dto: CloudConfigDto) {
    return this.cloud.saveConfig(accountId, dto);
  }

  @Post('sync')
  sync(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.cloud.sync(accountId);
  }

  @Get('templates')
  listTemplates(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.asHttp(this.cloud.listTemplates(accountId));
  }

  private async asHttp<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (e) {
      if (e instanceof MetaApiError) {
        throw new BadRequestException({ message: e.message, code: e.code });
      }
      throw e;
    }
  }
}
