import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/** Rotas HTTP internas exigem x-internal-key quando INTERNAL_API_KEY está definida. O webhook da Meta fica aberto. */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) return true;

    const req = context.switchToHttp().getRequest();
    const path: string = req.path ?? req.url ?? '';
    if (path.startsWith('/webhooks/cloud/')) return true;
    if (req.headers['x-internal-key'] === expected) return true;
    throw new UnauthorizedException();
  }
}
