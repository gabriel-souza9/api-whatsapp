# Funcionalidades — api-whatsapp

Documento detalhando o que a API faz, como cada parte funciona e como integrar.

## Visão geral

A `api-whatsapp` é um serviço NestJS que conecta contas de WhatsApp e envia
mensagens em nome delas. Foi pensada para o cenário multi-tenant do sistema de
pedidos: **cada conta (`accountId`) tem sua própria sessão de WhatsApp** e pode
notificar os clientes de forma escalável.

O provider padrão é o **Baileys** (WebSocket direto, sem Selenium/navegador),
isolado atrás de uma interface (`WhatsAppProvider`), de modo que outro provider
possa ser adicionado depois sem alterar controllers nem o consumer de fila.

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
  "text": "Pedido #123: Saiu para entrega"
}
```
- `type` ausente ou `"text"` → envia texto (`text`).
- `type` de mídia → envia mídia (mesmos campos do endpoint de mídia).
- Falhas no envio são logadas e **não derrubam** o consumo da fila.

### Integração com o back-sistema-de-pedidos
O `back-sistema-de-pedidos` publica nessa fila quando o **status de um pedido muda**
(em `OrderService.update`), enviando ao cliente uma mensagem do tipo
`Pedido #<id>: <status>`. A publicação é feita em `try/catch`, então uma falha de
mensageria nunca quebra a atualização do pedido.

## 6. Modelo de dados

`whatsapp_session`
| Campo | Tipo | Descrição |
|-------|------|-----------|
| accountId | int (PK) | Conta do sistema de pedidos |
| status | text | Estado da sessão |
| qr | text? | Último QR (data URL) quando aguardando leitura |
| phoneNumber | text? | Número conectado |
| createdAt / updatedAt | timestamp | Auditoria |

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
(`src/whatsapp/providers/messaging-provider.interface.ts`). O token
`WHATSAPP_PROVIDER` aponta hoje para `BaileysProvider`. Para adicionar outro
provider (ex.: API oficial do WhatsApp Cloud), basta implementar a mesma interface
e trocar o binding no `WhatsappModule` — controllers e consumer de fila não mudam.

## 8. Limitações / próximos passos

- A API REST não tem autenticação (serviço interno). Recomendado proteger antes de
  expor publicamente.
- Não há armazenamento de histórico de mensagens recebidas (foco é envio).
- Baileys é uma lib não oficial; uso sujeito aos Termos do WhatsApp.
