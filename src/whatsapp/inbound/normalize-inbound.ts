import { InboundMessageEnvelope, InboundMessageType } from './inbound-message.envelope';
import { normalizePhone } from '../../utils/normalizePhone';

const GROUP_SUFFIX = '@g.us';
const STATUS_JID = 'status@broadcast';
const BROADCAST_SUFFIX = '@broadcast';
const LID_SUFFIX = '@lid';
const PN_SUFFIX = '@s.whatsapp.net';

export function normalizeBaileysMessage(accountId: number, msg: any): InboundMessageEnvelope | null {
  return buildBaileysEnvelope(accountId, msg, false);
}

/** Mensagem do número conectado. O cliente é o chat (`remoteJid`), não o autor. */
export function normalizeBaileysOwnerMessage(accountId: number, msg: any): InboundMessageEnvelope | null {
  const envelope = buildBaileysEnvelope(accountId, msg, true);
  return envelope ? { ...envelope, handoff: true } : null;
}

function buildBaileysEnvelope(
  accountId: number,
  msg: any,
  owner: boolean,
): InboundMessageEnvelope | null {
  const key = msg?.key;
  if (!key?.id || (key.fromMe && !owner)) return null;

  const remoteJid: string = key.remoteJid || '';
  if (!remoteJid || remoteJid === STATUS_JID) return null;
  if (remoteJid.endsWith(GROUP_SUFFIX) || remoteJid.endsWith(BROADCAST_SUFFIX)) return null;

  const message = msg.message;
  if (!message || message.protocolMessage || message.reactionMessage) return null;

  const inner = unwrapMessage(message);
  if (!inner) return null;

  const { type, text, media, rawType } = classify(inner);
  const from = owner ? resolveChatPhone(key, remoteJid) : resolveSenderPhone(key, remoteJid);
  if (!from) return null;

  const ts = Number(msg.messageTimestamp);
  return {
    accountId,
    provider: 'baileys',
    externalMessageId: key.id,
    from,
    chatJid: remoteJid,
    timestamp: Number.isFinite(ts) ? ts * 1000 : Date.now(),
    type,
    text,
    media,
    rawType,
  };
}

/** Eco do app WhatsApp Business (`message_echoes`). O cliente está em `to`. */
export function normalizeCloudOwnerEcho(accountId: number, echo: any): InboundMessageEnvelope | null {
  if (!echo?.to) return null;
  const envelope = normalizeCloudMessage(accountId, { ...echo, from: echo.to });
  return envelope ? { ...envelope, handoff: true } : null;
}

/** Item de `value.messages` do webhook `messages` da Cloud API. Reações e mensagens sem remetente são ignoradas. */
export function normalizeCloudMessage(
  accountId: number,
  msg: any,
  businessPhone?: string,
): InboundMessageEnvelope | null {
  if (!msg?.id || !msg.from || msg.type === 'reaction') return null;
  const from = normalizePhone(String(msg.from));
  if (!from) return null;

  const ts = Number(msg.timestamp);
  const base = {
    accountId,
    provider: 'cloud_api' as const,
    externalMessageId: String(msg.id),
    from,
    to: businessPhone ? normalizePhone(businessPhone) : undefined,
    timestamp: Number.isFinite(ts) ? ts * 1000 : Date.now(),
    rawType: String(msg.type ?? 'unknown'),
  };

  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: msg.text?.body ? String(msg.text.body) : undefined };
    case 'interactive': {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      return { ...base, type: 'interactive', text: reply?.title ? String(reply.title) : reply?.id };
    }
    case 'button':
      return { ...base, type: 'interactive', text: msg.button?.text ?? msg.button?.payload };
    case 'image':
    case 'video':
    case 'audio':
    case 'document': {
      const media = msg[msg.type] ?? {};
      return {
        ...base,
        type: msg.type,
        text: media.caption ? String(media.caption) : undefined,
        media: { mimetype: media.mime_type, caption: media.caption },
      };
    }
    default:
      return { ...base, type: 'unknown' };
  }
}

/** Chat da mensagem do dono. `senderPn` e `participant` são o número conectado quando fromMe. */
function resolveChatPhone(key: any, remoteJid: string): string {
  if (remoteJid.endsWith(LID_SUFFIX)) {
    const alt = pickPn(key.remoteJidAlt);
    if (alt) return alt;
    const lidUser = remoteJid.split('@')[0]?.replace(/\D/g, '');
    return lidUser ? `lid${lidUser}` : '';
  }
  return normalizePhone(remoteJid.split('@')[0]);
}

/** Baileys 7: remoteJid pode ser @lid; o telefone vem em remoteJidAlt / senderPn. */
function resolveSenderPhone(key: any, remoteJid: string): string {
  if (remoteJid.endsWith(LID_SUFFIX)) {
    const alt =
      pickPn(key.remoteJidAlt) ||
      pickPn(key.senderPn) ||
      pickPn(key.participantAlt);
    // Sem PN: ainda respondemos no @lid; chave de conversa usa o LID (prefixo evita colisão).
    if (alt) return alt;
    const lidUser = remoteJid.split('@')[0]?.replace(/\D/g, '');
    return lidUser ? `lid${lidUser}` : '';
  }

  if (remoteJid.endsWith(PN_SUFFIX) || !remoteJid.includes('@')) {
    return normalizePhone(remoteJid.split('@')[0]);
  }

  return normalizePhone(remoteJid.split('@')[0]);
}

function pickPn(value?: string | null): string {
  if (!value) return '';
  if (value.endsWith(LID_SUFFIX)) return '';
  return normalizePhone(value.split('@')[0]);
}

function unwrapMessage(message: any): any {
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

function classify(message: any): {
  type: InboundMessageType;
  text?: string;
  media?: InboundMessageEnvelope['media'];
  rawType?: string;
} {
  if (message.conversation) {
    return { type: 'text', text: String(message.conversation), rawType: 'conversation' };
  }
  if (message.extendedTextMessage?.text) {
    return {
      type: 'text',
      text: String(message.extendedTextMessage.text),
      rawType: 'extendedTextMessage',
    };
  }
  if (message.buttonsResponseMessage?.selectedDisplayText || message.buttonsResponseMessage?.selectedButtonId) {
    return {
      type: 'interactive',
      text: String(
        message.buttonsResponseMessage.selectedDisplayText ||
          message.buttonsResponseMessage.selectedButtonId,
      ),
      rawType: 'buttonsResponseMessage',
    };
  }
  if (message.listResponseMessage?.title || message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return {
      type: 'interactive',
      text: String(
        message.listResponseMessage.title ||
          message.listResponseMessage.singleSelectReply?.selectedRowId,
      ),
      rawType: 'listResponseMessage',
    };
  }
  if (message.imageMessage) {
    return {
      type: 'image',
      text: message.imageMessage.caption ? String(message.imageMessage.caption) : undefined,
      media: {
        mimetype: message.imageMessage.mimetype,
        caption: message.imageMessage.caption,
      },
      rawType: 'imageMessage',
    };
  }
  if (message.videoMessage) {
    return {
      type: 'video',
      text: message.videoMessage.caption ? String(message.videoMessage.caption) : undefined,
      media: {
        mimetype: message.videoMessage.mimetype,
        caption: message.videoMessage.caption,
      },
      rawType: 'videoMessage',
    };
  }
  if (message.audioMessage) {
    return { type: 'audio', media: { mimetype: message.audioMessage.mimetype }, rawType: 'audioMessage' };
  }
  if (message.documentMessage) {
    return {
      type: 'document',
      text: message.documentMessage.caption ? String(message.documentMessage.caption) : undefined,
      media: {
        mimetype: message.documentMessage.mimetype,
        caption: message.documentMessage.caption,
      },
      rawType: 'documentMessage',
    };
  }
  const rawType = Object.keys(message)[0];
  return { type: 'unknown', rawType };
}
