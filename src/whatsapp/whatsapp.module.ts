import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { BaileysProvider } from './baileys.provider';
import { WHATSAPP_PROVIDER } from './providers/messaging-provider.interface';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappEventsController } from './whatsapp.events.controller';
import { SessionEventsService } from './session-events.service';
import { SESSION_EVENTS_CLIENT } from './session-events.constants';

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
    ]),
  ],
  controllers: [WhatsappController, WhatsappEventsController],
  providers: [
    BaileysProvider,
    SessionEventsService,
    { provide: WHATSAPP_PROVIDER, useExisting: BaileysProvider },
  ],
})
export class WhatsappModule {}
