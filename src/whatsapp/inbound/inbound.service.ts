import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhone } from '../../utils/normalizePhone';
import { InboundPublisher } from './inbound.publisher';
import { InboundMessageEnvelope } from './inbound-message.envelope';
import { normalizeBaileysMessage } from './normalize-inbound';

type BotGate = { ok: boolean; expiresAt: number };

@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);
  private readonly botGateCache = new Map<number, BotGate>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly publisher: InboundPublisher,
    private readonly prisma: PrismaService,
  ) {}

  handleBaileysUpsert(accountId: number, messages: any[], sock?: any) {
    for (const msg of messages) {
      try {
        const envelope = normalizeBaileysMessage(accountId, msg);
        if (!envelope) continue;
        void this.publishIfBotEnabled(envelope, sock);
      } catch (e: any) {
        this.logger.warn(
          `Falha ao normalizar inbound conta ${accountId}: ${e?.message}`,
        );
      }
    }
  }

  private async publishIfBotEnabled(envelope: InboundMessageEnvelope, sock?: any) {
    const enriched = await this.enrichPhoneFromLid(envelope, sock);

    this.logger.log(
      `Inbound ${enriched.externalMessageId} conta ${enriched.accountId} from=${enriched.from} chatJid=${enriched.chatJid ?? '-'}`,
    );

    const enabled = await this.isBotReady(enriched.accountId);
    if (!enabled) {
      this.logger.debug(
        `Conta ${enriched.accountId}: bot inativo — não publica ${enriched.externalMessageId}`,
      );
      return;
    }
    this.publisher.publish(enriched);
  }

  /** Completa o telefone real quando o Baileys só mandou @lid. */
  private async enrichPhoneFromLid(
    envelope: InboundMessageEnvelope,
    sock?: any,
  ): Promise<InboundMessageEnvelope> {
    const chatJid = envelope.chatJid;
    if (!chatJid?.endsWith('@lid')) return envelope;
    if (!envelope.from.startsWith('lid')) return envelope;

    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(chatJid);
      if (typeof pn === 'string' && pn.includes('@s.whatsapp.net')) {
        const phone = normalizePhone(pn.split('@')[0]);
        if (phone) {
          this.logger.log(`LID ${chatJid} resolvido para telefone ${phone}`);
          return { ...envelope, from: phone };
        }
      }
    } catch (e: any) {
      this.logger.warn(`Falha ao resolver LID→PN (${chatJid}): ${e?.message}`);
    }
    return envelope;
  }

  private async isBotReady(accountId: number): Promise<boolean> {
    const cached = this.botGateCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) return cached.ok;

    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ enabled: boolean; typebotPublicId: string | null }>
      >`
        SELECT enabled, "typebotPublicId"
        FROM account_bot_config
        WHERE "accountId" = ${accountId}
        LIMIT 1
      `;
      const row = rows[0];
      const ok = !!row?.enabled && !!row.typebotPublicId?.trim();
      this.botGateCache.set(accountId, {
        ok,
        expiresAt: Date.now() + InboundService.CACHE_TTL_MS,
      });
      return ok;
    } catch (e: any) {
      this.logger.warn(
        `Falha ao checar bot da conta ${accountId}: ${e?.message}`,
      );
      return false;
    }
  }
}
