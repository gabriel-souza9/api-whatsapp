import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { SendMediaDto, SendTextDto } from './dto/send-message.dto';
import { MetaApiError } from './cloud/meta-errors';
import { MessageLogService, ReportQuery } from './message-log.service';
import { RoutingProvider } from './routing.provider';

@Controller()
export class WhatsappController {
  constructor(
    private readonly provider: RoutingProvider,
    private readonly messageLog: MessageLogService,
  ) {}

  @Post('sessions/:accountId/start')
  start(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.provider.start(accountId);
  }

  @Post('sessions/:accountId/restart')
  restart(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.provider.restart(accountId);
  }

  @Delete('sessions/:accountId')
  async logout(@Param('accountId', ParseIntPipe) accountId: number) {
    await this.provider.logout(accountId);
    return { ok: true };
  }

  @Get('sessions/:accountId/status')
  status(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.provider.getStatus(accountId);
  }

  @Get('sessions/:accountId/qr')
  async qr(@Param('accountId', ParseIntPipe) accountId: number) {
    return { qr: await this.provider.getQr(accountId) };
  }

  @Post('messages/:accountId/text')
  sendText(
    @Param('accountId', ParseIntPipe) accountId: number,
    @Body() dto: SendTextDto,
  ) {
    return this.asHttp(
      this.messageLog.track(
        { accountId, to: dto.to, kind: 'text', origin: 'test', body: dto.text },
        () => this.provider.sendText(accountId, dto.to, dto.text),
      ),
    );
  }

  @Post('messages/:accountId/media')
  sendMedia(
    @Param('accountId', ParseIntPipe) accountId: number,
    @Body() dto: SendMediaDto,
  ) {
    return this.asHttp(
      this.messageLog.track(
        { accountId, to: dto.to, kind: dto.type, origin: 'test', body: dto.caption || dto.url || '' },
        () => this.provider.sendMedia(accountId, dto),
      ),
    );
  }

  @Get('messages/:accountId')
  report(@Param('accountId', ParseIntPipe) accountId: number, @Query() query: ReportQuery) {
    return this.messageLog.report(accountId, query);
  }

  private async asHttp<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (e) {
      if (e instanceof MetaApiError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
