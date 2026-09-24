export type InboundProvider = 'baileys' | 'cloud_api';

export type InboundMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'interactive'
  | 'unknown';

export interface InboundMedia {
  url?: string;
  mimetype?: string;
  caption?: string;
}

export interface InboundMessageEnvelope {
  accountId: number;
  provider: InboundProvider;
  externalMessageId: string;
  /** Telefone normalizado (E.164 só dígitos) */
  from: string;
  /** JID original do chat no provider (ex: xxx@lid) — preferir no reply */
  chatJid?: string;
  to?: string;
  timestamp: number;
  type: InboundMessageType;
  text?: string;
  media?: InboundMedia;
  rawType?: string;
}
