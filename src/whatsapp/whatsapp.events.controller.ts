import { Controller, Inject, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  SendMediaInput,
  WHATSAPP_PROVIDER,
  WhatsAppProvider,
} from './providers/messaging-provider.interface';

// Payload publicado pelo back-sistema-de-pedidos na fila whatsapp.notify
interface NotifyPayload {
  accountId: number;
  to: string;
  type?: 'text' | 'image' | 'video' | 'audio' | 'document';
  text?: string;
  url?: string;
  base64?: string;
  caption?: string;
  mimetype?: string;
  fileName?: string;
}

@Controller()
export class WhatsappEventsController {
  private readonly logger = new Logger(WhatsappEventsController.name);

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  @EventPattern('whatsapp.notify')
  async handleNotify(@Payload() payload: NotifyPayload) {
    try {
      if (!payload?.accountId || !payload?.to) return;

      if (!payload.type || payload.type === 'text') {
        await this.provider.sendText(payload.accountId, payload.to, payload.text ?? '');
        return;
      }

      await this.provider.sendMedia(payload.accountId, payload as SendMediaInput);
    } catch (e: any) {
      this.logger.error(
        `Falha ao notificar conta ${payload?.accountId} (${payload?.to}): ${e?.message}`,
      );
    }
  }
}
