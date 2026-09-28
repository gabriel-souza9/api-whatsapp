-- Cria apenas as tabelas do api-whatsapp no mesmo banco "orders",
-- sem tocar nas tabelas existentes do back-sistema-de-pedidos.

CREATE TABLE IF NOT EXISTS "whatsapp_session" (
  "accountId"   INTEGER PRIMARY KEY,
  "status"      TEXT NOT NULL DEFAULT 'DISCONNECTED',
  "qr"          TEXT,
  "phoneNumber" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "whatsapp_auth_key" (
  "id"        SERIAL PRIMARY KEY,
  "accountId" INTEGER NOT NULL REFERENCES "whatsapp_session"("accountId") ON DELETE CASCADE,
  "key"       TEXT NOT NULL,
  "value"     JSONB NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_auth_key_accountId_key_key"
  ON "whatsapp_auth_key" ("accountId", "key");

ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "wabaId" TEXT;
ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "phoneNumberId" TEXT;
ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "accessToken" TEXT;
ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "appSecret" TEXT;
ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "verifyToken" TEXT;
ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "whatsapp_session" ADD COLUMN IF NOT EXISTS "syncedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "whatsapp_message" (
  "id"              SERIAL PRIMARY KEY,
  "accountId"       INTEGER NOT NULL,
  "provider"        TEXT NOT NULL,
  "externalId"      TEXT,
  "to"              TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "origin"          TEXT NOT NULL,
  "orderId"         INTEGER,
  "orderStatus"     TEXT,
  "templateName"    TEXT,
  "body"            TEXT NOT NULL,
  "status"          TEXT NOT NULL,
  "errorCode"       INTEGER,
  "errorDetail"     TEXT,
  "pricingCategory" TEXT,
  "billable"        BOOLEAN,
  "sentAt"          TIMESTAMP(3),
  "deliveredAt"     TIMESTAMP(3),
  "readAt"          TIMESTAMP(3),
  "failedAt"        TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_message_externalId_key"
  ON "whatsapp_message" ("externalId");

CREATE INDEX IF NOT EXISTS "whatsapp_message_accountId_createdAt_idx"
  ON "whatsapp_message" ("accountId", "createdAt");
