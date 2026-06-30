import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { PrismaService } from '../prisma/prisma.service';

// Auth state do Baileys persistido no Postgres (tabela whatsapp_auth_key).
// Espelha o useMultiFileAuthState: cada "arquivo" vira uma linha key/value.
export async function usePostgresAuthState(accountId: number, prisma: PrismaService): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // BufferJSON.replacer converte Buffers em objetos planos serializaveis em JSONB.
  const serialize = (value: any) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  const deserialize = (value: any) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

  const writeData = (key: string, value: any) =>
    prisma.whatsappAuthKey.upsert({
      where: { accountId_key: { accountId, key } },
      create: { accountId, key, value: serialize(value) },
      update: { value: serialize(value) },
    });

  const readData = async (key: string) => {
    const row = await prisma.whatsappAuthKey.findUnique({
      where: { accountId_key: { accountId, key } },
    });
    return row ? deserialize(row.value) : null;
  };

  const removeData = (key: string) =>
    prisma.whatsappAuthKey.deleteMany({ where: { accountId, key } });

  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<any>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = (data as any)[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}
