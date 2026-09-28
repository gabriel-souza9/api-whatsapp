# Funcionalidades — api-whatsapp

Documento detalhando o que a API faz, como cada parte funciona e como integrar.

## Visão geral

A `api-whatsapp` é um serviço NestJS que conecta contas de WhatsApp e envia
mensagens em nome delas. Foi pensada para o cenário multi-tenant do sistema de
pedidos: **cada conta (`accountId`) tem sua própria sessão de WhatsApp** e pode
notificar os clientes de forma escalável.

Dois providers implementam a interface `WhatsAppProvider`:

- `BaileysProvider` (WebSocket direto, QR Code). Seções 1 a 3.
- `CloudApiProvider` (WhatsApp Cloud API oficial da Meta). Seção 9.

O `RoutingProvider` lê `Account.whatsappProvider` (`baileys` ou `waba`) a cada chamada, sem cache, e delega para o provider certo. Trocar o provider no Super Admin vale na hora.

## 1. Conexão e QR Code

- `POST /sessions/:accountId/start` cria (ou reaproveita) o socket da conta.
- Quando não há credenciais válidas, o Baileys emite um **QR Code**. Ele é
  convertido para **data URL** (imagem base64) e salvo na tabela
  `whatsapp_session` (coluna `qr`), além de refletir no `status = QR`.
- O front consulta `GET /sessions/:accountId/qr` e exibe a imagem para o usuário
  escanear no celular.
- Ao escanear, a conexão abre, o `status` vira `CONNECTED`, o `qr` é limpo e o
  número conectado é salvo em `phoneNumber`.

Estados possíveis (`status`): `DISCONNECTED`, `CONNECTING`, `QR`, `CONNECTED`.

## 2. Persistência da sessão

- As credenciais e chaves de assinatura do Baileys são guardadas no Postgres,
  na tabela `whatsapp_auth_key` (modelo key/value por `accountId`), espelhando o
  comportamento do `useMultiFileAuthState` oficial (usando `BufferJSON` para
  serializar Buffers em JSONB).
- Isso significa que **a sessão sobrevive a reinícios** do serviço: não é preciso
  reler o QR a cada deploy.
- As tabelas ficam no **mesmo banco `orders`** do back, criadas por um script SQL
  idempotente (`prisma/init.sql`, via `npm run db:init`) — sem `prisma migrate`/
  `db push`, para não impactar as tabelas existentes do back.

## 3. Reinício e reconexão

- `POST /sessions/:accountId/restart` encerra o socket atual e reconecta usando as
  credenciais já persistidas (não pede QR de novo).
- **Reconexão automática:** se a conexão cair por motivo diferente de logout, o
  provider tenta reconectar sozinho.
- **Boot resiliente:** ao subir, o serviço (`onModuleInit`) relê do banco todas as
  sessões marcadas como `CONNECTED` e as reconecta automaticamente.
- Conta com provider `waba` não reconecta pelo Baileys, e mensagem recebida pelo
  socket Baileys dessa conta não vai para o bot (evita resposta dupla).
- `DELETE /sessions/:accountId` faz logout no WhatsApp e **remove as credenciais**
  persistidas (a conta precisará escanear o QR de novo para reconectar).

## 4. Envio de mensagens

### Texto
`POST /messages/:accountId/text`
```json
{ "to": "5511999999999", "text": "Olá!" }
```

### Mídia
`POST /messages/:accountId/media`
```json
{
  "to": "5511999999999",
  "type": "image",
  "url": "https://exemplo.com/foto.png",
  "caption": "Seu pedido"
}
```
- `type`: `image` | `video` | `audio` | `document`.
- Origem do arquivo: `url` (recomendado) **ou** `base64`.
- Campos opcionais: `caption`, `mimetype` (default sensato por tipo) e `fileName`
  (para `document`).

### Normalização do destinatário
O campo `to` aceita o número em qualquer formato; o provider remove caracteres não
numéricos e monta o JID `XXXXXXXXXXX@s.whatsapp.net`. Se já vier com `@`, é usado
como está (útil para grupos/JIDs especiais).

### Pré-condição
O envio exige `status = CONNECTED`. Se a sessão não estiver conectada, a API
responde com erro `400`.

## 5. Notificações assíncronas (RabbitMQ)

Além do REST, a API consome a fila **`whatsapp.notify`** (RabbitMQ), o que permite
desacoplar e escalar o envio de notificações.

Payload:
```json
{
  "accountId": 1,
  "to": "5511999999999",
  "type": "text",
  "text": "Pedido #123: Saiu para entrega",
  "origin": "order_status",
  "orderId": 123,
  "orderStatus": "OUT_FOR_DELIVERY"
}
```
- `type` ausente ou `"text"` → envia texto (`text`).
- `type` de mídia → envia mídia (mesmos campos do endpoint de mídia).
- `type: "template"` → envia `template: { name, language, params }` (só Cloud API).
  `params` é um objeto `{ variavel: valor }`; valor vazio vira `-` porque a Meta
  recusa parâmetro vazio. `text` é o texto renderizado, gravado no registro.
- `origin` (`order_status`, `bot`, `test`) vai para o registro. Ausente = `order_status`.
- Todo envio passa pelo registro (seção 10). Falhas são logadas e **não derrubam**
  o consumo da fila.

### Integração com o back-sistema-de-pedidos
O back publica nessa fila quando o **status de um pedido muda**, com as mensagens
configuradas em Configurações → Mensagens. Conta Baileys recebe texto; conta WABA
recebe o template da Meta daquela mensagem. O bot-api publica as respostas do bot
com `origin: "bot"`.

## 6. Modelo de dados

`whatsapp_session`
| Campo | Tipo | Descrição |
|-------|------|-----------|
| accountId | int (PK) | Conta do sistema de pedidos |
| status | text | Estado da sessão |
| qr | text? | Último QR (data URL) quando aguardando leitura |
| phoneNumber | text? | Número conectado |
| wabaId / phoneNumberId | text? | Cloud API: ids da WABA e do número |
| accessToken / appSecret | text? | Cloud API: cifrados com `WHATSAPP_CREDENTIALS_KEY` |
| verifyToken | text? | Cloud API: token de verificação do webhook, gerado no primeiro save |
| lastError | text? | Cloud API: erro traduzido da última sincronização |
| syncedAt | timestamp? | Cloud API: última sincronização com sucesso |
| createdAt / updatedAt | timestamp | Auditoria |

`whatsapp_message` — uma linha por mensagem enviada (os dois providers)
| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | serial (PK) | — |
| accountId | int | Conta |
| provider | text | `baileys` ou `waba` |
| externalId | text (unique) | Id da mensagem no provider (`wamid…` na Cloud API) |
| to | text | Destino |
| kind | text | `text`, `template`, `image`, … |
| origin | text | `order_status`, `bot`, `test` |
| orderId / orderStatus | int? / text? | Pedido que gerou o aviso |
| templateName | text? | Template usado |
| body | text | Texto enviado (renderizado) |
| status | text | `accepted`, `sent`, `delivered`, `read`, `failed` |
| errorCode / errorDetail | int? / text? | Erro da Meta |
| pricingCategory / billable | text? / bool? | Cobrança informada pela Meta no webhook |
| sentAt / deliveredAt / readAt / failedAt | timestamp? | Momentos de cada status |
| | | índice (`accountId`, `createdAt`) |

`whatsapp_auth_key`
| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | serial (PK) | — |
| accountId | int (FK) | Referencia `whatsapp_session` |
| key | text | Nome do "arquivo" de credencial (ex.: `creds`) |
| value | jsonb | Conteúdo serializado (BufferJSON) |
| | | unique (`accountId`, `key`) |

## 7. Extensibilidade (outros providers)

A lógica de envio/conexão fica atrás da interface `WhatsAppProvider`
(`src/whatsapp/providers/messaging-provider.interface.ts`). Controllers e o
consumer de fila usam o `RoutingProvider`, que escolhe o provider pela conta.
Provider novo = implementar a interface e incluir no `RoutingProvider`.

## 8. Segurança

- Guard global (`InternalKeyGuard`): toda rota HTTP exige `x-internal-key` igual a
  `INTERNAL_API_KEY`. Só `/webhooks/cloud/*` fica aberta, porque quem chama é a Meta.
  Sem `INTERNAL_API_KEY` definida o guard libera tudo (desenvolvimento).
- Token e App Secret da Meta são gravados cifrados (AES-256-GCM) e nunca voltam na
  API; `GET /cloud/:accountId/config` só informa `hasAccessToken` e `hasAppSecret`.
- Com App Secret salvo, o POST do webhook só é processado com `X-Hub-Signature-256`
  válido (HMAC-SHA256 do corpo bruto). Sem App Secret (campo opcional), o webhook é
  aceito sem validar a origem e a tela de conexão mostra um aviso.

## 9. WhatsApp Cloud API (provider `waba`)

### Conexão
- `PUT /cloud/:accountId/config` grava `wabaId`, `phoneNumberId`, `accessToken` e
  `appSecret` (opcional). Token ou secret em branco mantém o valor salvo. Depois chama o sync.
- Sync (`POST /cloud/:accountId/sync`, também no `start`/`restart`):
  1. `GET /{phoneNumberId}` valida token e número.
  2. `GET /app` e `GET /{wabaId}/subscribed_apps`: se o app do token ainda não está
     inscrito na WABA, faz `POST /{wabaId}/subscribed_apps` sem override. Se já está,
     não mexe (preserva o override de WABA de outro sistema).
  3. `POST /{phoneNumberId}` com `webhook_configuration.override_callback_uri` =
     `WHATSAPP_PUBLIC_URL/webhooks/cloud/{accountId}` e o `verify_token` da conta.
     O override de número tem prioridade sobre o da WABA e o do app, e só afeta esse número.
  4. Sucesso: `status = CONNECTED`, grava o número e `syncedAt`, limpa `lastError`.
     Erro: `status = DISCONNECTED`, grava o erro traduzido em `lastError` e responde 400.
- `DELETE /sessions/:accountId` manda `override_callback_uri: ""` para o número (os
  eventos voltam para o webhook da WABA ou do app), marca `DISCONNECTED` e mantém as
  credenciais. Não desinscreve o app da WABA.
- Se outro sistema usar o mesmo número, ele para de receber os eventos desse número
  enquanto o PedeGo estiver conectado: a Meta manda cada evento para um só destino.
- `GET /cloud/:accountId/config` consulta o número na Meta: nome verificado,
  qualidade, `platform_type` e `is_on_biz_app` (coexistência).
- Sem Embedded Signup: o número já precisa estar na Cloud API.

### Envio
- Texto: `type: text` com `preview_url`. Só é entregue dentro da janela de 24h
  aberta pela última mensagem do cliente; fora dela a Meta devolve 131047.
- Mídia: só por `url` pública. `base64` é recusado.
- Template: idioma do payload (padrão `pt_BR`). `params` com chaves numéricas (`1`, `2`…)
  vai como posicional, em ordem e sem nome; senão vai nomeado (`parameter_name`).
  Só preenche o corpo.
- Destino `…@lid` é recusado (a Cloud API precisa do telefone).
- Retry: até 3 tentativas (espera 1s e 3s) só para erro transitório da Meta
  (1, 2, 4, 80007, 130429, 131000, 131016, 131057, 133004). Timeout de 15s por chamada.

### Templates
- A api não cria nem edita template; eles são criados no WhatsApp Manager.
- `GET /cloud/:accountId/templates` lista os templates da WABA (até 4 páginas de 250),
  todos os status e idiomas, ordenados por nome: `id`, `name`, `language`, `status`,
  `category`, `body`, `variables` (na ordem do corpo) e `unsupportedReason` quando há
  cabeçalho com mídia ou variável, ou botão que não seja resposta rápida, URL fixa
  ou telefone.

### Webhook (`/webhooks/cloud/:accountId`)
- `GET`: verificação da Meta (`hub.mode = subscribe` e `hub.verify_token` da conta);
  devolve `hub.challenge`.
- `POST`: valida a assinatura, responde 200 na hora e processa em seguida.
  - Só o campo `messages` é lido. `smb_message_echoes`, `history` e
    `smb_app_state_sync` (coexistência) são ignorados.
  - Evento de outro `phone_number_id` da mesma WABA é ignorado.
  - `statuses` atualizam o registro (seção 10).
  - `messages` são normalizadas (texto, botão, lista, mídia com legenda) e vão para
    `bot.message.inbound` com `provider: "cloud_api"`, se o bot da conta estiver ativo.
    Reação é ignorada.
  - `errors` só vão para o log.

## 10. Registro e relatório de mensagens enviadas

- Todo envio (fila e teste) grava uma linha em `whatsapp_message`.
  - Cloud API: `accepted` ao receber o `wamid`; o webhook leva a `sent`,
    `delivered`, `read` ou `failed`.
  - Baileys: `sent` no envio. Não há confirmação posterior.
  - Erro no envio: `failed` com código e detalhe da Meta.
- Status do webhook só avança (`accepted` → `sent` → `delivered` → `read`);
  `failed` substitui `sent`. Se o status chegar antes da linha existir, tenta de novo
  uma vez após 2s. Também grava `pricing.category` e `pricing.billable`.
- `GET /messages/:accountId`: filtros `from`/`to` (YYYY-MM-DD, fuso -03:00),
  `status`, `origin`, `search` (dígitos do telefone), `page`, `size` (máx. 100).
  Devolve `data` (com `errorMessage` traduzido para pt-BR em
  `src/whatsapp/cloud/meta-errors.ts`), `total`, `totalPages` e `summary` por status.
  O `summary` respeita período, origem e telefone, mas ignora o filtro de status.

## 11. Limitações

- Mensagens recebidas não são guardadas aqui (só repassadas ao bot).
- Baileys é uma lib não oficial; uso sujeito aos Termos do WhatsApp.
- Cloud API: sem onboarding pelo sistema, sem mídia em base64 e sem template com mídia.
