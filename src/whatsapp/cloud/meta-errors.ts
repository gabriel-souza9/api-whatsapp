// Códigos de erro da Cloud API (https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
const META_ERRORS: Record<number, string> = {
  0: 'Não foi possível autenticar. O token expirou ou foi invalidado — gere um novo token.',
  1: 'Requisição inválida ou erro temporário da Meta.',
  2: 'Serviço da Meta temporariamente indisponível.',
  3: 'O app não tem permissão para esta operação. Revise as permissões do token.',
  4: 'Limite de chamadas do app atingido. Tente novamente em instantes.',
  10: 'Permissão não concedida ou removida. Revise as permissões do token.',
  33: 'O número do WhatsApp Business foi excluído na Meta.',
  100: 'Parâmetro inválido. Confira o WABA ID, o Phone Number ID e os dados enviados.',
  190: 'Token de acesso expirado ou inválido. Gere um token permanente de System User.',
  200: 'Token sem permissão para este recurso.',
  368: 'Conta WhatsApp Business restrita ou desativada por violação de política.',
  80007: 'Limite de chamadas da conta WhatsApp Business atingido. Tente novamente mais tarde.',
  130403: 'O estabelecimento bloqueou este cliente no WhatsApp.',
  130429: 'Limite de envio por segundo atingido. Tente novamente em instantes.',
  130472: 'Mensagem não enviada: o cliente faz parte de um experimento da Meta.',
  130497: 'A conta não pode enviar mensagens para o país deste cliente.',
  131000: 'Falha desconhecida na Meta ao enviar a mensagem.',
  131005: 'Permissão negada para enviar mensagens. Revise as permissões do token.',
  131008: 'Parâmetro obrigatório ausente na mensagem.',
  131009: 'Valor de parâmetro inválido (confira o número do cliente).',
  131016: 'Serviço da Meta temporariamente indisponível.',
  131021: 'O destinatário é o próprio número do estabelecimento.',
  131026: 'Mensagem não entregue: o número não tem WhatsApp, não aceitou os termos atuais ou usa uma versão antiga do app.',
  131031: 'Conta WhatsApp Business bloqueada ou dados da conta não conferem.',
  131037: 'O número ainda não tem nome de exibição aprovado.',
  131042: 'Problema na forma de pagamento da conta WhatsApp Business na Meta.',
  131045: 'Número do estabelecimento não registrado na Cloud API.',
  131047: 'Fora da janela de 24h: o cliente não mandou mensagem nas últimas 24 horas. Use um template.',
  131048: 'Envio limitado: muitas mensagens deste número foram bloqueadas ou marcadas como spam.',
  131049: 'A Meta não entregou para manter o engajamento saudável (limite por cliente).',
  131050: 'O cliente optou por não receber mensagens de marketing deste estabelecimento.',
  131051: 'Tipo de mensagem não suportado.',
  131052: 'Não foi possível baixar a mídia enviada pelo cliente.',
  131053: 'Não foi possível enviar a mídia (formato ou URL inválidos).',
  131056: 'Muitas mensagens para o mesmo cliente em pouco tempo. Aguarde e tente novamente.',
  131057: 'Conta WhatsApp Business em manutenção.',
  131063: 'Template classificado como marketing, mas marketing está desativado na Cloud API.',
  131064: 'Limite de envio atingido por categorização incorreta de templates.',
  132000: 'Quantidade de variáveis enviada não confere com o template.',
  132001: 'Template inexistente em pt_BR ou ainda não aprovado pela Meta.',
  132005: 'Texto do template muito longo após preencher as variáveis.',
  132007: 'O conteúdo do template viola uma política do WhatsApp.',
  132012: 'Formato das variáveis não confere com o template.',
  132015: 'Template pausado pela Meta por baixa qualidade.',
  132016: 'Template desativado permanentemente pela Meta. Crie um texto novo.',
  133004: 'Servidor da Meta temporariamente indisponível.',
  133010: 'Número do estabelecimento não registrado na Cloud API.',
  135000: 'Falha desconhecida nos parâmetros da mensagem.',
  2388019: 'Limite de templates da conta atingido (250).',
  2388039: 'O template está em análise e não pode ser editado agora.',
  2388040: 'O texto excede o limite de caracteres permitido.',
  2388072: 'Formato do texto do template inválido.',
  2388293: 'Muitas variáveis para um texto tão curto. Escreva mais texto ou use menos variáveis.',
  2388299: 'O texto não pode começar nem terminar com uma variável.',
  2494100: 'Número do estabelecimento em manutenção. Tente em alguns minutos.',
};

export const TRANSIENT_META_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131057, 133004]);

export function describeMetaError(code?: number | null): string {
  if (code == null) return 'Erro desconhecido';
  return META_ERRORS[code] ?? `Erro da Meta (código ${code})`;
}

export class MetaApiError extends Error {
  constructor(
    readonly code: number,
    readonly details: string,
    readonly fbtraceId?: string,
  ) {
    super(`${describeMetaError(code)}${details ? ` (${details})` : ''}`);
  }
}
