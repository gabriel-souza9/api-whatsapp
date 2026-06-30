# api-whatsapp

API em **NestJS** para integrar o sistema de pedidos ao **WhatsApp**. Usa o
[Baileys](https://github.com/WhiskeySockets/Baileys) como provider padrão
(conexão direta via WebSocket, sem navegador), com arquitetura preparada para
plugar outros providers no futuro.

## O que ela faz

- Conecta uma conta de WhatsApp por **accountId** (multi-tenant) via **QR Code**.
- **Persiste a sessão** no Postgres, então não precisa ler o QR toda hora.
- **Reinicia/reconecta** sessões automaticamente (inclusive ao subir o serviço).
- **Envia mensagens de texto e mídia** (imagem, vídeo, áudio, documento).
- Recebe pedidos de notificação por **RabbitMQ** (fila `whatsapp.notify`),
  permitindo que o `back-sistema-de-pedidos` avise os clientes de forma escalável
  (ex.: a cada mudança de status do pedido).

## Arquitetura

```
back-sistema-de-pedidos --(publish whatsapp.notify)--> RabbitMQ
                                                          |
                                                          v
Painel/Front --(REST: QR, start, restart, envio)--> api-whatsapp --(Baileys)--> WhatsApp
                                                          |
                                                          v
                                       Postgres "orders" (tabelas whatsapp_*)
```

## Stack

- NestJS 11, Node 22 (ver `.nvmrc`)
- Baileys `7.0.0-rc13`
- Prisma 6 + Postgres (mesmo banco `orders`, tabelas `whatsapp_session` e `whatsapp_auth_key`)
- RabbitMQ (`@nestjs/microservices`)

## Variáveis de ambiente (`.env`)

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/orders"
PORT=3002
RABBITMQ_URL="amqp://guest:guest@localhost:5672"
RABBITMQ_QUEUE="whatsapp.notify"
```

## Como rodar

1. Suba a infra (Postgres + RabbitMQ) pelo `docker-compose.yml` do `back-sistema-de-pedidos`:
   ```bash
   cd ../back-sistema-de-pedidos && docker compose up -d
   ```
2. Instale e prepare o banco (cria só as tabelas do WhatsApp, sem mexer nas do back):
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

## Endpoints REST

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/sessions/:accountId/start` | Inicia a sessão (gera QR se necessário) |
| POST | `/sessions/:accountId/restart` | Reinicia a sessão mantendo as credenciais |
| DELETE | `/sessions/:accountId` | Faz logout e apaga as credenciais |
| GET | `/sessions/:accountId/status` | Status atual (`DISCONNECTED`/`CONNECTING`/`QR`/`CONNECTED`) |
| GET | `/sessions/:accountId/qr` | QR Code atual (data URL) |
| POST | `/messages/:accountId/text` | Envia texto `{ to, text }` |
| POST | `/messages/:accountId/media` | Envia mídia `{ to, type, url\|base64, caption, mimetype, fileName }` |

## Notificações via RabbitMQ

O serviço consome a fila `whatsapp.notify`. Payload esperado:

```json
{
  "accountId": 1,
  "to": "5511999999999",
  "type": "text",
  "text": "Pedido #123: Saiu para entrega"
}
```

Para mídia, use `type` = `image`/`video`/`audio`/`document` e `url` ou `base64`.

Detalhes completos em [docs/FUNCIONALIDADES.md](docs/FUNCIONALIDADES.md).
