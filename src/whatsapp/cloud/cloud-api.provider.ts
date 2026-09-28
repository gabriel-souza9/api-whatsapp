import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt } from '../../utils/crypto';
import { normalizePhone } from '../../utils/normalizePhone';
import { SessionEventsService } from '../session-events.service';
import {
  SendMediaInput,
  SendTemplateInput,
  SessionState,
  WhatsAppProvider,
} from '../providers/messaging-provider.interface';
import { MetaApiError, TRANSIENT_META_CODES } from './meta-errors';

const GRAPH_URL = 'https://graph.facebook.com';
const PHONE_FIELDS = 'display_phone_number,verified_name,quality_rating,platform_type,is_on_biz_app';
const RETRY_DELAYS_MS = [1000, 3000];

export interface CloudConfigInput {
  wabaId: string;
  phoneNumberId: string;
  accessToken?: string;
  appSecret?: string;
}

export interface CloudTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  body: string;
  /** Variáveis do corpo na ordem em que aparecem: nomes (`nome`) ou posições (`1`, `2`). */
  variables: string[];
  /** Motivo quando o sistema não consegue preencher o template (cabeçalho com mídia/variável, botão dinâmico). */
  unsupportedReason?: string;
}

const TEMPLATE_VARIABLE_RE = /\{\{\s*(\w+)\s*\}\}/g;
const SUPPORTED_BUTTONS = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']);

interface Credentials {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
}

@Injectable()
export class CloudApiProvider implements WhatsAppProvider {
  private readonly logger = new Logger(CloudApiProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  // ---------- Conexão ----------

  async saveConfig(accountId: number, input: CloudConfigInput) {
    const current = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    const accessToken = input.accessToken?.trim() || (current?.accessToken ? decrypt(current.accessToken) : '');
    const appSecret = input.appSecret?.trim() || (current?.appSecret ? decrypt(current.appSecret) : '');
    if (!accessToken) throw new BadRequestException('Informe o token de acesso');

    const data = {
      wabaId: input.wabaId.trim(),
      phoneNumberId: input.phoneNumberId.trim(),
      accessToken: encrypt(accessToken),
      appSecret: appSecret ? encrypt(appSecret) : null,
      verifyToken: current?.verifyToken || randomBytes(24).toString('hex'),
    };
    await this.prisma.whatsappSession.upsert({
      where: { accountId },
      create: { accountId, status: 'DISCONNECTED', ...data },
      update: data,
    });
    return this.sync(accountId);
  }

  /**
   * Valida credenciais e aponta o webhook do número para esta conta.
   * O override é por número (tem prioridade sobre o da WABA e o do app), então outros números
   * e outros sistemas na mesma WABA continuam recebendo os próprios eventos.
   */
  async sync(accountId: number) {
    const creds = await this.requireCredentials(accountId);
    const publicUrl = process.env.WHATSAPP_PUBLIC_URL?.replace(/\/$/, '');
    if (!publicUrl) throw new BadRequestException('WHATSAPP_PUBLIC_URL não configurada na api-whatsapp');

    try {
      const phone = await this.graph<any>(creds.accessToken, 'GET', `/${creds.phoneNumberId}`, undefined, {
        fields: PHONE_FIELDS,
      });
      await this.ensureAppSubscribed(creds);
      await this.graph(creds.accessToken, 'POST', `/${creds.phoneNumberId}`, {
        webhook_configuration: {
          override_callback_uri: `${publicUrl}/webhooks/cloud/${accountId}`,
          verify_token: creds.verifyToken,
        },
      });
      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: {
          status: 'CONNECTED',
          qr: null,
          phoneNumber: normalizePhone(phone?.display_phone_number) || null,
          lastError: null,
          syncedAt: new Date(),
        },
      });
      this.logger.log(`Conta ${accountId}: Cloud API sincronizada (${phone?.display_phone_number})`);
    } catch (e: any) {
      const message = e instanceof MetaApiError ? e.message : e?.message || 'Falha ao sincronizar';
      await this.prisma.whatsappSession.update({
        where: { accountId },
        data: { status: 'DISCONNECTED', lastError: message },
      });
      this.emitSession(accountId);
      throw new BadRequestException(message);
    }
    this.emitSession(accountId);
    return this.getConfig(accountId);
  }

  async getConfig(accountId: number) {
    const session = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    const publicUrl = process.env.WHATSAPP_PUBLIC_URL?.replace(/\/$/, '') || '';
    const configured = !!(session?.wabaId && session.phoneNumberId && session.accessToken);
    const base = {
      configured,
      wabaId: session?.wabaId ?? '',
      phoneNumberId: session?.phoneNumberId ?? '',
      hasAccessToken: !!session?.accessToken,
      hasAppSecret: !!session?.appSecret,
      webhookUrl: publicUrl ? `${publicUrl}/webhooks/cloud/${accountId}` : '',
      verifyToken: session?.verifyToken ?? '',
      status: session?.status ?? 'DISCONNECTED',
      phoneNumber: session?.phoneNumber ?? null,
      lastError: session?.lastError ?? null,
      syncedAt: session?.syncedAt ?? null,
      phone: null as null | {
        displayPhoneNumber?: string;
        verifiedName?: string;
        qualityRating?: string;
        platformType?: string;
        isOnBizApp?: boolean;
      },
    };
    if (!configured) return base;

    try {
      const creds = await this.requireCredentials(accountId);
      const phone = await this.graph<any>(creds.accessToken, 'GET', `/${creds.phoneNumberId}`, undefined, {
        fields: PHONE_FIELDS,
      });
      base.phone = {
        displayPhoneNumber: phone?.display_phone_number,
        verifiedName: phone?.verified_name,
        qualityRating: phone?.quality_rating,
        platformType: phone?.platform_type,
        isOnBizApp: !!phone?.is_on_biz_app,
      };
    } catch (e: any) {
      this.logger.warn(`Conta ${accountId}: falha ao ler dados do número: ${e?.message}`);
    }
    return base;
  }

  async start(accountId: number): Promise<SessionState> {
    const session = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    if (session?.accessToken) await this.sync(accountId);
    return this.getStatus(accountId);
  }

  restart(accountId: number): Promise<SessionState> {
    return this.start(accountId);
  }

  /**
   * Remove só o override do número (eventos voltam para o webhook da WABA/app).
   * Não desinscreve o app da WABA: isso derrubaria outros sistemas que usam o mesmo app.
   */
  async logout(accountId: number): Promise<void> {
    const session = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    if (session?.accessToken && session.phoneNumberId) {
      try {
        const creds = await this.requireCredentials(accountId);
        await this.graph(creds.accessToken, 'POST', `/${creds.phoneNumberId}`, {
          webhook_configuration: { override_callback_uri: '' },
        });
      } catch (e: any) {
        this.logger.warn(`Conta ${accountId}: falha ao remover webhook do número: ${e?.message}`);
      }
    }
    await this.prisma.whatsappSession.upsert({
      where: { accountId },
      create: { accountId, status: 'DISCONNECTED' },
      update: { status: 'DISCONNECTED', qr: null },
    });
    this.emitSession(accountId);
  }

  async getStatus(accountId: number): Promise<SessionState> {
    const session = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    return {
      accountId,
      status: (session?.status as SessionState['status']) ?? 'DISCONNECTED',
      qr: null,
      phoneNumber: session?.phoneNumber ?? null,
    };
  }

  async getQr(): Promise<string | null> {
    return null;
  }

  async getWebhookConfig(
    accountId: number,
  ): Promise<{ appSecret: string | null; verifyToken: string; phoneNumberId: string } | null> {
    const s = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    if (!s?.verifyToken || !s.phoneNumberId) return null;
    return {
      appSecret: s.appSecret ? decrypt(s.appSecret) : null,
      verifyToken: s.verifyToken,
      phoneNumberId: s.phoneNumberId,
    };
  }

  // ---------- Envio ----------

  async sendText(accountId: number, to: string, text: string): Promise<{ id: string }> {
    return this.sendMessage(accountId, to, { type: 'text', text: { body: text, preview_url: true } });
  }

  async sendMedia(accountId: number, input: SendMediaInput): Promise<{ id: string }> {
    if (!input.url) {
      throw new BadRequestException('Na Cloud API a mídia precisa ser enviada por URL pública (base64 não suportado)');
    }
    const media: Record<string, string> = { link: input.url };
    if (input.caption && input.type !== 'audio') media.caption = input.caption;
    if (input.type === 'document' && input.fileName) media.filename = input.fileName;
    return this.sendMessage(accountId, input.to, { type: input.type, [input.type]: media });
  }

  async sendTemplate(accountId: number, input: SendTemplateInput): Promise<{ id: string }> {
    const params = Object.entries(input.params ?? {});
    // Template posicional ({{1}}, {{2}}) recebe os parâmetros na ordem e sem parameter_name.
    const positional = params.length > 0 && params.every(([key]) => /^\d+$/.test(key));
    if (positional) params.sort(([a], [b]) => Number(a) - Number(b));
    const template: Record<string, unknown> = {
      name: input.name,
      language: { code: input.language || 'pt_BR' },
    };
    if (params.length) {
      template.components = [
        {
          type: 'body',
          parameters: params.map(([name, value]) => ({
            type: 'text',
            ...(positional ? {} : { parameter_name: name }),
            text: value?.trim() || '-',
          })),
        },
      ];
    }
    return this.sendMessage(accountId, input.to, { type: 'template', template });
  }

  private async sendMessage(accountId: number, to: string, content: Record<string, unknown>) {
    const creds = await this.requireCredentials(accountId);
    const recipient = this.toRecipient(to);
    const res = await this.withRetry(() =>
      this.graph<{ messages?: Array<{ id: string }> }>(
        creds.accessToken,
        'POST',
        `/${creds.phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...content },
      ),
    );
    const id = res?.messages?.[0]?.id ?? '';
    this.logger.log(`Conta ${accountId}: ${content.type} enviado para ${recipient} (id=${id})`);
    return { id };
  }

  // ---------- Templates ----------

  /** Templates da WABA (todas as páginas, até 1000), com corpo e variáveis. Os templates são criados no WhatsApp Manager. */
  async listTemplates(accountId: number): Promise<CloudTemplate[]> {
    const creds = await this.requireCredentials(accountId);
    const raw: any[] = [];
    let after: string | undefined;
    for (let page = 0; page < 4; page++) {
      const res = await this.graph<{ data?: any[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        creds.accessToken,
        'GET',
        `/${creds.wabaId}/message_templates`,
        undefined,
        { fields: 'id,name,status,category,language,components', limit: '250', ...(after ? { after } : {}) },
      );
      raw.push(...(res?.data ?? []));
      after = res?.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return raw.map((t) => this.toCloudTemplate(t)).sort((a, b) => a.name.localeCompare(b.name));
  }

  private toCloudTemplate(t: any): CloudTemplate {
    const components: any[] = t.components ?? [];
    const body = String(components.find((c) => c.type === 'BODY')?.text ?? '');
    const header = components.find((c) => c.type === 'HEADER');
    const buttons: any[] = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];

    let unsupportedReason: string | undefined;
    if (header && header.format !== 'TEXT') unsupportedReason = 'Cabeçalho com mídia';
    else if (header && /\{\{/.test(header.text ?? '')) unsupportedReason = 'Cabeçalho com variável';
    else if (buttons.some((b) => !SUPPORTED_BUTTONS.has(b.type) || /\{\{/.test(b.url ?? ''))) {
      unsupportedReason = 'Botão com valor dinâmico';
    }

    return {
      id: String(t.id),
      name: String(t.name),
      language: String(t.language ?? ''),
      status: String(t.status ?? ''),
      category: t.category,
      body,
      variables: [...new Set([...body.matchAll(TEMPLATE_VARIABLE_RE)].map((m) => m[1]))],
      unsupportedReason,
    };
  }

  // ---------- Infra ----------

  private async requireCredentials(accountId: number): Promise<Credentials> {
    const s = await this.prisma.whatsappSession.findUnique({ where: { accountId } });
    if (!s?.wabaId || !s.phoneNumberId || !s.accessToken || !s.verifyToken) {
      throw new BadRequestException(`Cloud API da conta ${accountId} não configurada`);
    }
    return {
      wabaId: s.wabaId,
      phoneNumberId: s.phoneNumberId,
      accessToken: decrypt(s.accessToken),
      verifyToken: s.verifyToken,
    };
  }

  /** Override de número exige o app do token inscrito na WABA; só inscreve se ainda não estiver. */
  private async ensureAppSubscribed(creds: Credentials) {
    const [app, subs] = await Promise.all([
      this.graph<{ id?: string }>(creds.accessToken, 'GET', '/app'),
      this.graph<{ data?: Array<{ whatsapp_business_api_data?: { id?: string } }> }>(
        creds.accessToken,
        'GET',
        `/${creds.wabaId}/subscribed_apps`,
      ),
    ]);
    const subscribed = (subs?.data ?? []).some((s) => s.whatsapp_business_api_data?.id === app?.id);
    if (!subscribed) await this.graph(creds.accessToken, 'POST', `/${creds.wabaId}/subscribed_apps`);
  }

  private toRecipient(to: string): string {
    const user = to.split('@')[0];
    if (user.startsWith('lid')) throw new BadRequestException('Destino sem número de telefone');
    return normalizePhone(user);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const transient = e instanceof MetaApiError && TRANSIENT_META_CODES.has(e.code);
        if (!transient || attempt >= RETRY_DELAYS_MS.length) throw e;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private async graph<T = unknown>(
    token: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const version = process.env.META_GRAPH_VERSION || 'v25.0';
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetch(`${GRAPH_URL}/${version}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      const err = json?.error ?? {};
      throw new MetaApiError(
        Number(err.code ?? res.status),
        err.error_data?.details || err.error_user_msg || err.message || res.statusText,
        err.fbtrace_id,
      );
    }
    return json as T;
  }

  private emitSession(accountId: number) {
    this.getStatus(accountId)
      .then((state) => this.sessionEvents.emit(state))
      .catch((e) => this.logger.warn(`Falha ao emitir sessão ${accountId}: ${e?.message}`));
  }
}
