import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { SendMediaDto, SendTextDto } from './dto/send-message.dto';
import {
  WHATSAPP_PROVIDER,
  WhatsAppProvider,
} from './providers/messaging-provider.interface';

@Controller()
export class WhatsappController {
  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
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
    return this.provider.sendText(accountId, dto.to, dto.text);
  }

  @Post('messages/:accountId/media')
  sendMedia(
    @Param('accountId', ParseIntPipe) accountId: number,
    @Body() dto: SendMediaDto,
  ) {
    return this.provider.sendMedia(accountId, dto);
  }
}
