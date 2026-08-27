import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function comparacaoSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * HTTP Basic Auth simples — usuário é ignorado, só a senha importa.
 * `senha` undefined desliga a checagem inteira (comportamento explícito de
 * quem chama, não um default escondido aqui).
 */
export function criarMiddlewareBasicAuth(senha: string | undefined, realm: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!senha) {
      next();
      return;
    }

    const cabecalho = req.headers.authorization;
    if (cabecalho?.startsWith('Basic ')) {
      const decodificado = Buffer.from(cabecalho.slice('Basic '.length), 'base64').toString('utf-8');
      const senhaRecebida = decodificado.slice(decodificado.indexOf(':') + 1);
      if (comparacaoSegura(senhaRecebida, senha)) {
        next();
        return;
      }
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
    res.status(401).json({ erro: 'autenticação necessária' });
  };
}
