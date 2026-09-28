import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaileysProvider } from './baileys.provider';
import { CloudApiProvider } from './cloud/cloud-api.provider';
import { readAccountProvider } from './providers/account-provider';
import {
  AccountProvider,
  SendMediaInput,
  SendTemplateInput,
  SessionState,
  WhatsAppProvider,
} from './providers/messaging-provider.interface';

/** Escolhe o provider da conta a cada chamada. */
@Injectable()
export class RoutingProvider implements WhatsAppProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly baileys: BaileysProvider,
    private readonly cloud: CloudApiProvider,
  ) {}

  providerOf(accountId: number): Promise<AccountProvider> {
    return readAccountProvider(this.prisma, accountId);
  }

  private async pick(accountId: number): Promise<WhatsAppProvider> {
    return (await this.providerOf(accountId)) === 'waba' ? this.cloud : this.baileys;
  }

  async start(accountId: number): Promise<SessionState> {
    return (await this.pick(accountId)).start(accountId);
  }

  async restart(accountId: number): Promise<SessionState> {
    return (await this.pick(accountId)).restart(accountId);
  }

  async logout(accountId: number): Promise<void> {
    return (await this.pick(accountId)).logout(accountId);
  }

  async getStatus(accountId: number): Promise<SessionState> {
    return (await this.pick(accountId)).getStatus(accountId);
  }

  async getQr(accountId: number): Promise<string | null> {
    return (await this.pick(accountId)).getQr(accountId);
  }

  async sendText(accountId: number, to: string, text: string): Promise<{ id: string }> {
    return (await this.pick(accountId)).sendText(accountId, to, text);
  }

  async sendMedia(accountId: number, input: SendMediaInput): Promise<{ id: string }> {
    return (await this.pick(accountId)).sendMedia(accountId, input);
  }

  async sendTemplate(accountId: number, input: SendTemplateInput): Promise<{ id: string }> {
    if ((await this.providerOf(accountId)) !== 'waba') {
      throw new BadRequestException('Templates só existem na Cloud API (WABA)');
    }
    return this.cloud.sendTemplate(accountId, input);
  }
}
