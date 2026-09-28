import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { SendMediaInput, SendTemplateInput } from './providers/messaging-provider.interface';
import { MessageLogService, MessageOrigin } from './message-log.service';
import { RoutingProvider } from './routing.provider';

// Payload publicado na fila whatsapp.notify (back-sistema-de-pedidos e bot-api)
interface NotifyPayload {
  accountId: number;
  to: string;
  type?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'template';
  text?: string;
  url?: string;
  base64?: string;
  caption?: string;
  mimetype?: string;
  fileName?: string;
  template?: Omit<SendTemplateInput, 'to'>;
  origin?: MessageOrigin;
  orderId?: number;
  orderStatus?: string;
}

@Controller()
export class WhatsappEventsController {
  private readonly logger = new Logger(WhatsappEventsController.name);

  constructor(
    private readonly provider: RoutingProvider,
    private readonly messageLog: MessageLogService,
  ) {}

  @EventPattern('whatsapp.notify')
  async handleNotify(@Payload() payload: NotifyPayload) {
    if (!payload?.accountId || !payload?.to) return;
    const type = payload.type || 'text';
    const { accountId, to } = payload;

    try {
      await this.messageLog.track(
        {
          accountId,
          to,
          kind: type,
          origin: payload.origin ?? 'order_status',
          body: payload.text || payload.caption || payload.url || '',
          orderId: payload.orderId,
          orderStatus: payload.orderStatus,
          templateName: payload.template?.name,
        },
        () => {
          if (type === 'template') {
            if (!payload.template?.name) throw new Error('Template sem nome');
            return this.provider.sendTemplate(accountId, { ...payload.template, to });
          }
          if (type === 'text') return this.provider.sendText(accountId, to, payload.text ?? '');
          return this.provider.sendMedia(accountId, payload as SendMediaInput);
        },
      );
    } catch (e: any) {
      this.logger.error(`Falha ao notificar conta ${accountId} (${to}): ${e?.message}`);
    }
  }
}
