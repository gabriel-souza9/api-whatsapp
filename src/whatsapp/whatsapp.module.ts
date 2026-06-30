import { Module } from '@nestjs/common';
import { BaileysProvider } from './baileys.provider';
import { WHATSAPP_PROVIDER } from './providers/messaging-provider.interface';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappEventsController } from './whatsapp.events.controller';

@Module({
  controllers: [WhatsappController, WhatsappEventsController],
  providers: [
    BaileysProvider,
    { provide: WHATSAPP_PROVIDER, useExisting: BaileysProvider },
  ],
})
export class WhatsappModule {}
