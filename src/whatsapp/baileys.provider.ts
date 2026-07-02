import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  AnyMessageContent,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
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
  private readonly reconnectTimers = new Map<number, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<number, number>();
  private readonly saveCredsHandlers = new Map<number, () => Promise<void>>();
  private cachedVersion: [number, number, number] | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 12;
  private static readonly WATCHDOG_INTERVAL_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  // Reconecta sessões com credenciais salvas ao subir o serviço.
  async onModuleInit() {
    const credsRows = await this.prisma.whatsappAuthKey.findMany({
      where: { key: 'creds' },
      select: { accountId: true, value: true },
    });

    for (const row of credsRows) {
      const registered = Boolean((row.value as { registered?: boolean })?.registered);
      if (!registered) continue;
      this.start(row.accountId).catch((e) =>
        this.logger.warn(`Falha ao reconectar conta ${row.accountId}: ${e?.message}`),
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
      const version = await this.getWaVersion();
      const hasPersistedCreds = Boolean(state.creds?.registered);
      this.logger.log(
        `Conta ${accountId}: iniciando sessão (${hasPersistedCreds ? 'credenciais salvas' : 'sessão nova, vai gerar QR'})`,
      );

      const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }) as any,
        browser: Browsers.windows('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
      });

      this.sockets.set(accountId, sock);
      this.saveCredsHandlers.set(accountId, saveCreds);
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) =>
        this.handleConnectionUpdate(accountId, update),
      );
    } finally {
      this.starting.delete(accountId);
    }

    return this.getStatus(accountId);
  }

  private async getWaVersion(): Promise<[number, number, number]> {
    if (!this.cachedVersion) {
      const { version } = await fetchLatestBaileysVersion();
      this.cachedVersion = version;
      this.logger.log(`Versão WA Web: ${version.join('.')}`);
    }
    return this.cachedVersion;
  }

  private getDisconnectCode(lastDisconnect: any): number | undefined {
    const error = lastDisconnect?.error;
    if (!error) return undefined;

    const boom = error as Boom;
    if (boom.output?.statusCode) return boom.output.statusCode;
    if ((error as { status?: number }).status) return (error as { status: number }).status;
    if ((error as { statusCode?: number }).statusCode) {
      return (error as { statusCode: number }).statusCode;
    }

    const message = String(error.message || '');
    const match = message.match(/\b(40[0-9]|428|440|500|503|515)\b/);
    return match ? Number(match[1]) : undefined;
  }

  private formatDisconnectError(lastDisconnect: any): string {
    const error = lastDisconnect?.error;
    if (!error) return 'sem detalhe';
    const parts = [error.name, error.message].filter(Boolean);
    return parts.join(': ') || 'erro desconhecido';
  }

  private async hasRegisteredCreds(accountId: number): Promise<boolean> {
    const row = await this.prisma.whatsappAuthKey.findUnique({
      where: { accountId_key: { accountId, key: 'creds' } },
    });
    return Boolean((row?.value as { registered?: boolean })?.registered);
  }

  private async shouldReconnect(accountId: number, code: number | undefined): Promise<boolean> {
    if (code === DisconnectReason.loggedOut) return false;

    const permanentCodes = [
      DisconnectReason.forbidden,
      DisconnectReason.badSession,
      DisconnectReason.multideviceMismatch,
      DisconnectReason.connectionReplaced,
      DisconnectReason.unavailableService,
    ];
    if (code != null && permanentCodes.includes(code)) return false;

    return this.hasRegisteredCreds(accountId);
  }

  private getReconnectDelay(code: number | undefined, attempt: number, watchdog = false): number {
    if (watchdog) return BaileysProvider.WATCHDOG_INTERVAL_MS;
    if (code === DisconnectReason.restartRequired) return 1500;
    if (
      code === DisconnectReason.timedOut ||
      code === DisconnectReason.connectionLost ||
      code === DisconnectReason.connectionClosed
    ) {
      return Math.min(3000 * attempt, 20_000);
    }
    return Math.min(2000 * attempt, 15_000);
  }

  private clearReconnectTimer(accountId: number) {
    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }
  }

  private scheduleReconnect(
    accountId: number,
    delayMs: number,
    code?: number,
    watchdog = false,
  ) {
    this.clearReconnectTimer(accountId);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(accountId);
      this.start(accountId).catch((e) =>
        this.logger.error(`Erro ao reconectar conta ${accountId}: ${e?.message}`),
      );
    }, delayMs);
    this.reconnectTimers.set(accountId, timer);
    if (watchdog) {
      this.logger.log(
        `Conta ${accountId}: watchdog ativo, nova tentativa em ${delayMs / 1000}s`,
      );
    } else {
      const attempt = this.reconnectAttempts.get(accountId) ?? 0;
      this.logger.log(
        `Conta ${accountId}: reconectando em ${delayMs / 1000}s (tentativa ${attempt}, code=${code ?? 'unknown'})`,
      );
    }
  }

  private closeSocket(accountId: number) {
    const sock = this.sockets.get(accountId);
    if (!sock) return;
    try {
      sock.end(undefined);
    } catch {
      // ignore
    }
    this.sockets.delete(accountId);
    this.saveCredsHandlers.delete(accountId);
  }

  private async handleConnectionUpdate(accountId: number, update: any) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (isNewLogin) {
      this.logger.log(`Conta ${accountId}: login concluído, salvando credenciais`);
      const saveCreds = this.saveCredsHandlers.get(accountId);
      if (saveCreds) {
        await saveCreds().catch((e) =>
          this.logger.warn(`Conta ${accountId}: falha ao salvar credenciais: ${e?.message}`),
        );
      }
    }

    if (qr) {
      this.logger.log(`Conta ${accountId}: novo QR Code gerado`);
      const dataUrl = await QRCode.toDataURL(qr);
      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: { status: 'QR', qr: dataUrl },
      });
      this.emitSession(accountId);
    }

    if (connection === 'open') {
      this.clearReconnectTimer(accountId);
      this.reconnectAttempts.delete(accountId);
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
      this.closeSocket(accountId);
      const code = this.getDisconnectCode(lastDisconnect);
      const errorDetail = this.formatDisconnectError(lastDisconnect);

      this.logger.warn(
        `Conta ${accountId} desconectada (code=${code ?? 'unknown'}, ${errorDetail})`,
      );

      if (code === DisconnectReason.loggedOut) {
        this.clearReconnectTimer(accountId);
        this.reconnectAttempts.delete(accountId);
        await this.prisma.whatsappAuthKey.deleteMany({ where: { accountId } });
        await this.prisma.whatsappSession.update({
          where: { accountId },
          data: { status: 'DISCONNECTED', qr: null, phoneNumber: null },
        });
        this.logger.warn(`Conta ${accountId} deslogada`);
        this.emitSession(accountId);
        return;
      }

      if (!(await this.shouldReconnect(accountId, code))) {
        this.clearReconnectTimer(accountId);
        this.reconnectAttempts.delete(accountId);
        await this.prisma.whatsappSession.update({
          where: { accountId },
          data: { status: 'DISCONNECTED', qr: null },
        });
        this.emitSession(accountId);
        return;
      }

      const attempt = (this.reconnectAttempts.get(accountId) ?? 0) + 1;
      if (attempt > BaileysProvider.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts.set(accountId, attempt);
        await this.prisma.whatsappSession.update({
          where: { accountId },
          data: { status: 'CONNECTING', qr: null },
        });
        this.emitSession(accountId);
        this.scheduleReconnect(
          accountId,
          BaileysProvider.WATCHDOG_INTERVAL_MS,
          code,
          true,
        );
        return;
      }

      this.reconnectAttempts.set(accountId, attempt);
      const delayMs = this.getReconnectDelay(code, attempt);

      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: { status: 'CONNECTING', qr: null },
      });
      this.emitSession(accountId);
      this.scheduleReconnect(accountId, delayMs, code);
    }
  }

  async restart(accountId: number): Promise<SessionState> {
    this.clearReconnectTimer(accountId);
    this.reconnectAttempts.delete(accountId);
    this.closeSocket(accountId);
    return this.start(accountId);
  }

  async logout(accountId: number): Promise<void> {
    this.clearReconnectTimer(accountId);
    this.reconnectAttempts.delete(accountId);
    this.saveCredsHandlers.delete(accountId);
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
