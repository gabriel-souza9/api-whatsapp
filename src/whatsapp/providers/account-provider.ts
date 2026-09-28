import { PrismaService } from '../../prisma/prisma.service';
import { AccountProvider } from './messaging-provider.interface';

/** Lê Account.whatsappProvider (tabela do back). Sem cache: troca de provider vale na hora. */
export async function readAccountProvider(
  prisma: PrismaService,
  accountId: number,
): Promise<AccountProvider> {
  const rows = await prisma.$queryRaw<Array<{ whatsappProvider: string | null }>>`
    SELECT "whatsappProvider" FROM "Account" WHERE id = ${accountId} LIMIT 1
  `;
  return rows[0]?.whatsappProvider === 'waba' ? 'waba' : 'baileys';
}
