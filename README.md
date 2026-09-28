# api-whatsapp

API em **NestJS** para integrar o sistema de pedidos ao **WhatsApp**. Cada conta usa um de dois providers, escolhido em `Account.whatsappProvider`:

- `baileys`: [Baileys](https://github.com/WhiskeySockets/Baileys), conexão por QR Code (WebSocket direto, sem navegador).
- `waba`: **WhatsApp Cloud API** oficial da Meta. Serve para número só na API e para número em coexistência (app WhatsApp Business + API).

## O que ela faz

- Conecta uma conta por **accountId** (multi-tenant): QR Code no Baileys, credenciais da Meta na Cloud API.
- **Persiste a sessão** no Postgres. Credenciais da Meta ficam criptografadas (AES-256-GCM).
- **Reinicia/reconecta** sessões Baileys automaticamente (inclusive ao subir o serviço).
- **Envia texto, mídia e template** (template só na Cloud API).
- Recebe pedidos de notificação por **RabbitMQ** (fila `whatsapp.notify`), vindos do back (status do pedido) e do bot-api (respostas do bot).
- **Registra toda mensagem enviada** em `whatsapp_message` e atualiza o status com o webhook da Meta (entregue, lida, falhou).
- Recebe mensagens dos clientes (Baileys pelo socket, Cloud API pelo webhook) e publica em `bot.message.inbound` quando o bot da conta está ativo.

## Arquitetura

```
back-sistema-de-pedidos --(publish whatsapp.notify)--> RabbitMQ <--(publish whatsapp.notify)-- bot-api
                                                          |
                                                          v
Back (proxy REST, x-internal-key) ------------------> api-whatsapp --(Baileys)--> WhatsApp
                                                          |  \--(Graph API)--> Meta Cloud API
Meta --(POST /webhooks/cloud/:accountId)--------------->  |
                                                          v
                                       Postgres "orders" (tabelas whatsapp_*)
```

## Stack

- NestJS 11, Node 22 (ver `.nvmrc`)
- Baileys `7.0.0-rc13`
- Meta Graph API (versão em `META_GRAPH_VERSION`)
- Prisma 6 + Postgres (mesmo banco `orders`, tabelas `whatsapp_session`, `whatsapp_auth_key` e `whatsapp_message`)
- RabbitMQ (`@nestjs/microservices`)

## Variáveis de ambiente (`.env`)

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/orders"
PORT=3002
RABBITMQ_URL="amqp://guest:guest@localhost:5672"
RABBITMQ_QUEUE="whatsapp.notify"

# Cloud API (WABA)
WHATSAPP_PUBLIC_URL="https://whatsapp.seudominio.com.br"   # URL pública desta API, usada no webhook da Meta
WHATSAPP_CREDENTIALS_KEY="uma-chave-longa-e-aleatoria"      # cifra token e App Secret no banco; não troque depois de salvar credenciais
INTERNAL_API_KEY="outra-chave-longa"                        # exigida no header x-internal-key (o back manda WHATSAPP_INTERNAL_KEY)
META_GRAPH_VERSION="v25.0"                                  # opcional
```

Sem `INTERNAL_API_KEY` o guard libera tudo (só para desenvolvimento). Com a API exposta por causa do webhook, defina sempre.

## Como rodar

1. Suba a infra (Postgres + RabbitMQ) pelo `docker-compose.yml` do `back-sistema-de-pedidos`:
   ```bash
   cd ../back-sistema-de-pedidos && docker compose up -d
   ```
2. Instale e prepare o banco (cria/atualiza só as tabelas do WhatsApp, sem mexer nas do back):
   ```bash
   nvm use
   npm install
   npm run db:init
   ```
3. Suba a API:
   ```bash
   npm run start:dev
   ```
4. Documentação Swagger em `http://localhost:3002/api`.

## Pré-requisitos na Meta (Cloud API)

1. App na Meta for Developers com o produto **WhatsApp**.
2. Número conectado à Cloud API na WABA (o sistema não faz Embedded Signup nem onboarding de coexistência).
3. **Usuário do sistema** no Business Manager com o app e a WABA atribuídos, e token permanente com `whatsapp_business_messaging` e `whatsapp_business_management`.
4. No app, em WhatsApp → Configuração, o campo de webhook **`messages`** assinado. A URL é trocada só para o número da conta (override de número) ao salvar/sincronizar.
5. App Secret (Configurações do app → Básico), opcional. Com ele a api valida a assinatura `X-Hub-Signature-256`; sem ele o webhook é aceito sem validar a origem.

## Endpoints REST

Todas exigem `x-internal-key`, exceto `/webhooks/cloud/*`.

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/sessions/:accountId/start` | Baileys: inicia a sessão (gera QR). Cloud: sincroniza se já configurada |
| POST | `/sessions/:accountId/restart` | Reinicia a sessão |
| DELETE | `/sessions/:accountId` | Baileys: logout e apaga credenciais. Cloud: remove o webhook do número e mantém as credenciais |
| GET | `/sessions/:accountId/status` | Status atual (`DISCONNECTED`/`CONNECTING`/`QR`/`CONNECTED`) |
| GET | `/sessions/:accountId/qr` | QR Code atual (data URL). Cloud devolve vazio |
| POST | `/messages/:accountId/text` | Envia texto `{ to, text }` (registrado com origem `test`) |
| POST | `/messages/:accountId/media` | Envia mídia `{ to, type, url\|base64, caption, mimetype, fileName }`. Cloud aceita só `url` |
| GET | `/messages/:accountId` | Relatório de mensagens enviadas (`from`, `to`, `status`, `origin`, `search`, `page`, `size`) |
| GET | `/cloud/:accountId/config` | Credenciais (sem token/secret), webhook, verify token e dados do número |
| PUT | `/cloud/:accountId/config` | Salva `{ wabaId, phoneNumberId, accessToken?, appSecret? }` e sincroniza |
| POST | `/cloud/:accountId/sync` | Valida o número e aponta o webhook do número para esta conta |
| GET | `/cloud/:accountId/templates` | Templates da WABA com corpo, variáveis e status (não cria template) |
| GET/POST | `/webhooks/cloud/:accountId` | Webhook da Meta (verificação e eventos). Público |

## Notificações via RabbitMQ

O serviço consome a fila `whatsapp.notify`. Payload:

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

- Mídia: `type` = `image`/`video`/`audio`/`document` com `url` ou `base64`.
- Template (Cloud API): `type` = `template`, `template: { name, language, params }` e `text` renderizado (só para o registro).
- `origin`: `order_status` (padrão), `bot` ou `test`.

Detalhes completos em [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md). Preços da Meta em [comercial/whatsapp-cloud-api-precos.md](../comercial/whatsapp-cloud-api-precos.md).
