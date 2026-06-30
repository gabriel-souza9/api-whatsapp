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
