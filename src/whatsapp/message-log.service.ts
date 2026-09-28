import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { describeMetaError, MetaApiError } from './cloud/meta-errors';
import { readAccountProvider } from './providers/account-provider';

export type MessageOrigin = 'order_status' | 'bot' | 'test';

export interface TrackInput {
  accountId: number;
  to: string;
  kind: string;
  origin: MessageOrigin;
  body: string;
  orderId?: number;
  orderStatus?: string;
  templateName?: string;
}

export interface ReportQuery {
  from?: string;
  to?: string;
  status?: string;
  origin?: string;
  search?: string;
  page?: number;
  size?: number;
}

// Status só avança; `failed` não sobrescreve mensagem já entregue/lida.
const RANK: Record<string, number> = { accepted: 0, sent: 1, failed: 1, delivered: 2, read: 3 };
const STATUS_RETRY_MS = 2000;

@Injectable()
export class MessageLogService {
  private readonly logger = new Logger(MessageLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Executa o envio e registra o resultado. Relança o erro do envio. */
  async track(input: TrackInput, send: () => Promise<{ id: string }>): Promise<{ id: string }> {
    const provider = await readAccountProvider(this.prisma, input.accountId);
    const now = new Date();
    try {
      const res = await send();
      await this.save({
        ...input,
        provider,
        externalId: res.id || null,
        // Na Cloud API o "sent" chega pelo webhook; no Baileys o envio aceito já é o máximo conhecido.
        status: provider === 'waba' ? 'accepted' : 'sent',
        sentAt: provider === 'waba' ? null : now,
      });
      return res;
    } catch (e: any) {
      const meta = e instanceof MetaApiError ? e : null;
      await this.save({
        ...input,
        provider,
        status: 'failed',
        errorCode: meta?.code ?? null,
        errorDetail: meta ? meta.details : String(e?.message ?? e),
        failedAt: now,
      });
      throw e;
    }
  }

  /** Item de `value.statuses` do webhook da Cloud API. */
  async applyStatus(item: any, retried = false): Promise<void> {
    const externalId = item?.id ? String(item.id) : '';
    const status = String(item?.status ?? '');
    if (!externalId || !(status in RANK)) return;

    const current = await this.prisma.whatsappMessage.findUnique({ where: { externalId } });
    if (!current) {
      // O webhook pode chegar antes de gravarmos a resposta do envio.
      if (!retried) {
        setTimeout(() => void this.applyStatus(item, true).catch(() => undefined), STATUS_RETRY_MS);
      }
      return;
    }

    const at = new Date(Number(item.timestamp) * 1000 || Date.now());
    const data: Prisma.WhatsappMessageUpdateInput = {};
    if (item.pricing) {
      data.billable = typeof item.pricing.billable === 'boolean' ? item.pricing.billable : undefined;
      data.pricingCategory = item.pricing.category ?? undefined;
    }

    if (RANK[status] > RANK[current.status] || (status === 'failed' && current.status === 'sent')) {
      data.status = status;
    }
    if (status === 'sent' && !current.sentAt) data.sentAt = at;
    if (status === 'delivered' && !current.deliveredAt) data.deliveredAt = at;
    if (status === 'read') {
      if (!current.readAt) data.readAt = at;
      if (!current.deliveredAt) data.deliveredAt = at;
    }
    if (status === 'failed' && data.status === 'failed') {
      const error = item.errors?.[0];
      data.failedAt = at;
      data.errorCode = error?.code != null ? Number(error.code) : null;
      data.errorDetail = error?.error_data?.details || error?.message || error?.title || null;
    }

    if (Object.keys(data).length) {
      await this.prisma.whatsappMessage.update({ where: { id: current.id }, data });
    }
  }

  async report(accountId: number, q: ReportQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.size) || 30));

    const where: Prisma.WhatsappMessageWhereInput = { accountId };
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00-03:00`) } : {}),
        ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999-03:00`) } : {}),
      };
    }
    if (q.origin) where.origin = q.origin;
    const digits = q.search?.replace(/\D/g, '');
    if (digits) where.to = { contains: digits };

    const listWhere = q.status ? { ...where, status: q.status } : where;

    const [rows, total, grouped] = await Promise.all([
      this.prisma.whatsappMessage.findMany({
        where: listWhere,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.whatsappMessage.count({ where: listWhere }),
      this.prisma.whatsappMessage.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    const summary = { total: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const g of grouped) {
      summary.total += g._count._all;
      if (g.status in summary) summary[g.status as keyof typeof summary] += g._count._all;
    }

    return {
      data: rows.map((r) => ({
        ...r,
        errorMessage:
          r.status !== 'failed' ? null : r.errorCode != null ? describeMetaError(r.errorCode) : r.errorDetail,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary,
    };
  }

  private async save(data: Prisma.WhatsappMessageUncheckedCreateInput & { provider: string }) {
    try {
      await this.prisma.whatsappMessage.create({ data });
    } catch (e: any) {
      this.logger.warn(`Falha ao registrar mensagem da conta ${data.accountId}: ${e?.message}`);
    }
  }
}
