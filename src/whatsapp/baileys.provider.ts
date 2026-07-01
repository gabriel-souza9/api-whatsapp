import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  AnyMessageContent,
  Browsers,
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { usePostgresAuthState } from './postgres-auth';
import { SessionEventsService } from './session-events.service';
import {
  SendMediaInput,
  SessionState,
  WhatsAppProvider,
} from './providers/messaging-provider.interface';

@Injectable()
export class BaileysProvider implements WhatsAppProvider, OnModuleInit {
  private readonly logger = new Logger(BaileysProvider.name);
  private readonly sockets = new Map<number, WASocket>();
  private readonly starting = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  // Reconecta sessões que estavam conectadas antes de reiniciar o serviço.
  async onModuleInit() {
    const sessions = await this.prisma.whatsappSession.findMany({
      where: { status: 'CONNECTED' },
      select: { accountId: true },
    });
    for (const { accountId } of sessions) {
      this.start(accountId).catch((e) =>
        this.logger.warn(`Falha ao reconectar conta ${accountId}: ${e?.message}`),
      );
    }
  }

  async start(accountId: number): Promise<SessionState> {
    const existing = this.sockets.get(accountId);
    if (existing) return this.getStatus(accountId);
    if (this.starting.has(accountId)) return this.getStatus(accountId);

    this.starting.add(accountId);
    try {
      await this.prisma.whatsappSession.upsert({
        where: { accountId },
        create: { accountId, status: 'CONNECTING' },
        update: { status: 'CONNECTING' },
      });
      this.emitSession(accountId);

      const { state, saveCreds } = await usePostgresAuthState(accountId, this.prisma);

      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }) as any,
        browser: Browsers.ubuntu('Pedidos'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      this.sockets.set(accountId, sock);
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) =>
        this.handleConnectionUpdate(accountId, update),
      );
    } finally {
      this.starting.delete(accountId);
    }

    return this.getStatus(accountId);
  }

  private async handleConnectionUpdate(accountId: number, update: any) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr);
      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: { status: 'QR', qr: dataUrl },
      });
      this.emitSession(accountId);
    }

    if (connection === 'open') {
      const sock = this.sockets.get(accountId);
      const phoneNumber = sock?.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: { status: 'CONNECTED', qr: null, phoneNumber },
      });
      this.logger.log(`Conta ${accountId} conectada (${phoneNumber})`);
      this.emitSession(accountId);
    }

    if (connection === 'close') {
      this.sockets.delete(accountId);
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (loggedOut) {
        await this.prisma.whatsappAuthKey.deleteMany({ where: { accountId } });
        await this.prisma.whatsappSession.update({
          where: { accountId },
          data: { status: 'DISCONNECTED', qr: null, phoneNumber: null },
        });
        this.logger.warn(`Conta ${accountId} deslogada`);
        this.emitSession(accountId);
        return;
      }

      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: { status: 'DISCONNECTED' },
      });
      this.logger.warn(`Conta ${accountId} desconectada, reconectando...`);
      this.emitSession(accountId);
      this.start(accountId).catch((e) =>
        this.logger.error(`Erro ao reconectar conta ${accountId}: ${e?.message}`),
      );
    }
  }

  async restart(accountId: number): Promise<SessionState> {
    const sock = this.sockets.get(accountId);
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
      this.sockets.delete(accountId);
    }
    return this.start(accountId);
  }

  async logout(accountId: number): Promise<void> {
    const sock = this.sockets.get(accountId);
    if (sock) {
      try {
        await sock.logout();
      } catch {
        // ignore
      }
      this.sockets.delete(accountId);
    }
    await this.prisma.whatsappAuthKey.deleteMany({ where: { accountId } });
    await this.prisma.whatsappSession.upsert({
      where: { accountId },
      create: { accountId, status: 'DISCONNECTED' },
      update: { status: 'DISCONNECTED', qr: null, phoneNumber: null },
    });
    this.emitSession(accountId);
  }

  async getStatus(accountId: number): Promise<SessionState> {
    const session = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    if (!session) {
      return { accountId, status: 'DISCONNECTED', qr: null, phoneNumber: null };
    }
    return {
      accountId,
      status: session.status as SessionState['status'],
      qr: session.qr,
      phoneNumber: session.phoneNumber,
    };
  }

  async getQr(accountId: number): Promise<string | null> {
    const session = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    return session?.qr ?? null;
  }

  async sendText(accountId: number, to: string, text: string): Promise<{ id: string }> {
    const sock = this.requireConnected(accountId);
    const sent = await sock.sendMessage(this.toJid(to), { text });
    return { id: sent?.key?.id ?? '' };
  }

  async sendMedia(accountId: number, input: SendMediaInput): Promise<{ id: string }> {
    const sock = this.requireConnected(accountId);
    const media = input.url ? { url: input.url } : Buffer.from(input.base64 ?? '', 'base64');

    let content: AnyMessageContent;
    switch (input.type) {
      case 'image':
        content = { image: media, caption: input.caption };
        break;
      case 'video':
        content = { video: media, caption: input.caption };
        break;
      case 'audio':
        content = { audio: media, mimetype: input.mimetype ?? 'audio/mp4' };
        break;
      case 'document':
        content = {
          document: media,
          mimetype: input.mimetype ?? 'application/octet-stream',
          fileName: input.fileName,
          caption: input.caption,
        };
        break;
      default:
        throw new BadRequestException(`Tipo de mídia inválido: ${input.type}`);
    }

    const sent = await sock.sendMessage(this.toJid(input.to), content);
    return { id: sent?.key?.id ?? '' };
  }

  private requireConnected(accountId: number): WASocket {
    const sock = this.sockets.get(accountId);
    if (!sock) {
      throw new BadRequestException(`Sessão da conta ${accountId} não está conectada`);
    }
    return sock;
  }

  private toJid(to: string): string {
    if (to.includes('@')) return to;
    const digits = to.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  private emitSession(accountId: number) {
    this.getStatus(accountId)
      .then((state) => this.sessionEvents.emit(state))
      .catch((e) => this.logger.warn(`Falha ao emitir sessão ${accountId}: ${e?.message}`));
  }
}
