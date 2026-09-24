import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { INBOUND_EVENTS_CLIENT } from './inbound.constants';
import { InboundMessageEnvelope } from './inbound-message.envelope';

@Injectable()
export class InboundPublisher {
  private readonly logger = new Logger(InboundPublisher.name);

  constructor(@Inject(INBOUND_EVENTS_CLIENT) private readonly client: ClientProxy) {}

  publish(envelope: InboundMessageEnvelope) {
    this.client.emit('bot.message.inbound', envelope);
  }
}
