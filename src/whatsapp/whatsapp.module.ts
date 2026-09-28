import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { BaileysProvider } from './baileys.provider';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappEventsController } from './whatsapp.events.controller';
import { SessionEventsService } from './session-events.service';
import { SESSION_EVENTS_CLIENT } from './session-events.constants';
import { INBOUND_EVENTS_CLIENT } from './inbound/inbound.constants';
import { InboundPublisher } from './inbound/inbound.publisher';
import { InboundService } from './inbound/inbound.service';
import { CloudApiProvider } from './cloud/cloud-api.provider';
import { CloudController } from './cloud/cloud.controller';
import { CloudWebhookController } from './cloud/cloud-webhook.controller';
import { MessageLogService } from './message-log.service';
import { RoutingProvider } from './routing.provider';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: SESSION_EVENTS_CLIENT,
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
          queue: process.env.WHATSAPP_SESSION_QUEUE ?? 'whatsapp.session',
          queueOptions: { durable: true },
        },
      },
      {
        name: INBOUND_EVENTS_CLIENT,
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
          queue: process.env.BOT_INBOUND_QUEUE ?? 'bot.message.inbound',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [WhatsappController, WhatsappEventsController, CloudController, CloudWebhookController],
  providers: [
    BaileysProvider,
    CloudApiProvider,
    RoutingProvider,
    MessageLogService,
    SessionEventsService,
    InboundPublisher,
    InboundService,
  ],
})
export class WhatsappModule {}
