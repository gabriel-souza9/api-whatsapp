import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { SessionState } from './providers/messaging-provider.interface';
import { SESSION_EVENTS_CLIENT } from './session-events.constants';

@Injectable()
export class SessionEventsService {
  constructor(@Inject(SESSION_EVENTS_CLIENT) private client: ClientProxy) {}

  emit(state: SessionState) {
    this.client.emit('whatsapp.session.updated', state);
  }
}
