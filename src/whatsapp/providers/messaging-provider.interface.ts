export const WHATSAPP_PROVIDER = 'WHATSAPP_PROVIDER';

export type SessionStatus = 'DISCONNECTED' | 'CONNECTING' | 'QR' | 'CONNECTED';

export interface SessionState {
  accountId: number;
  status: SessionStatus;
  qr: string | null;
  phoneNumber: string | null;
}

export type MediaType = 'image' | 'video' | 'audio' | 'document';

export interface SendMediaInput {
  to: string;
  type: MediaType;
  url?: string;
  base64?: string;
  caption?: string;
  mimetype?: string;
  fileName?: string;
}

export interface WhatsAppProvider {
  /** Inicia/garante a sessão da conta (gera QR se necessário) */
  start(accountId: number): Promise<SessionState>;
  /** Reinicia a sessão (fecha o socket e conecta de novo, mantendo as credenciais) */
  restart(accountId: number): Promise<SessionState>;
  /** Faz logout e remove as credenciais persistidas */
  logout(accountId: number): Promise<void>;
  /** Status atual da sessão */
  getStatus(accountId: number): Promise<SessionState>;
  /** QR atual (data URL) quando aguardando leitura */
  getQr(accountId: number): Promise<string | null>;
  /** Envia mensagem de texto */
  sendText(accountId: number, to: string, text: string): Promise<{ id: string }>;
  /** Envia mídia (imagem, vídeo, áudio ou documento) */
  sendMedia(accountId: number, input: SendMediaInput): Promise<{ id: string }>;
}
