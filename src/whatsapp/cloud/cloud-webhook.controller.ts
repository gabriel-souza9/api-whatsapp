import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { InboundService } from '../inbound/inbound.service';
import { normalizeCloudMessage } from '../inbound/normalize-inbound';
import { MessageLogService } from '../message-log.service';
import { CloudApiProvider } from './cloud-api.provider';

/** Webhook da Meta por conta (override_callback_uri da WABA). Rota pública. */
@Controller('webhooks/cloud')
export class CloudWebhookController {
  private readonly logger = new Logger(CloudWebhookController.name);

  constructor(
    private readonly cloud: CloudApiProvider,
    private readonly messageLog: MessageLogService,
    private readonly inbound: InboundService,
  ) {}

  @Get(':accountId')
  async verify(
    @Param('accountId', ParseIntPipe) accountId: number,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const config = await this.cloud.getWebhookConfig(accountId);
    if (mode !== 'subscribe' || !config || token !== config.verifyToken) {
      throw new ForbiddenException();
    }
    return challenge;
  }

  @Post(':accountId')
  @HttpCode(200)
  async receive(
    @Param('accountId', ParseIntPipe) accountId: number,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    const config = await this.cloud.getWebhookConfig(accountId);
    if (!config) throw new NotFoundException();
    // Sem App Secret a conta aceita o webhook sem validar origem (a tela avisa o risco).
    if (config.appSecret && !this.validSignature(req.rawBody, signature, config.appSecret)) {
      this.logger.warn(`Conta ${accountId}: webhook com assinatura inválida`);
      throw new ForbiddenException();
    }

    // Responde já; a Meta reenvia se demorar.
    setImmediate(() => {
      this.process(accountId, config.phoneNumberId, req.body).catch((e) =>
        this.logger.error(`Conta ${accountId}: falha ao processar webhook: ${e?.message}`),
      );
    });
    return 'OK';
  }

  private validSignature(raw: Buffer | undefined, signature: string | undefined, secret: string) {
    if (!raw || !signature?.startsWith('sha256=')) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private async process(accountId: number, phoneNumberId: string, body: any) {
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        // smb_message_echoes, history e smb_app_state_sync (coexistência) não entram no fluxo.
        if (change?.field !== 'messages') continue;
        const value = change.value ?? {};
        // Override é por WABA: ignora eventos de outros números da mesma WABA.
        if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneNumberId) continue;

        for (const status of value.statuses ?? []) {
          await this.messageLog.applyStatus(status);
        }

        const envelopes = (value.messages ?? [])
          .map((m: any) => normalizeCloudMessage(accountId, m, value.metadata?.display_phone_number))
          .filter(Boolean);
        if (envelopes.length) this.inbound.handleCloudMessages(envelopes);

        for (const error of value.errors ?? []) {
          this.logger.warn(`Conta ${accountId}: erro da Meta ${error?.code}: ${error?.message}`);
        }
      }
    }
  }
}
