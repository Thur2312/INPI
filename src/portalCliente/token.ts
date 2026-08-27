import { createHmac } from 'node:crypto';
import { comparacaoSegura } from '../utils/basicAuth.js';

/**
 * Sessão do cliente sem senha (login só por CNPJ/CPF, decisão de negócio —
 * ver conversa com o operador em 27/08/2026). Sem armazenar estado de
 * sessão no servidor: o token carrega o documento e a validade, assinados
 * com HMAC — quem não tem `segredo` não consegue forjar um token para um
 * documento que não pesquisou. Isso não substitui uma senha de verdade se
 * o caso de uso mudar (documento não é segredo), só evita reenviar o
 * CNPJ em toda requisição e permite expirar a sessão.
 */
export function assinarToken(documento: string, segredo: string, validadeMs: number): string {
  const validoAte = Date.now() + validadeMs;
  const payload = `${documento}.${validoAte}`;
  const assinatura = createHmac('sha256', segredo).update(payload).digest('hex');
  return Buffer.from(`${payload}.${assinatura}`, 'utf-8').toString('base64url');
}

export function verificarToken(token: string, segredo: string): { documento: string } | null {
  let decodificado: string;
  try {
    decodificado = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  const partes = decodificado.split('.');
  if (partes.length !== 3) return null;
  const [documento, validoAteTexto, assinatura] = partes as [string, string, string];

  const payload = `${documento}.${validoAteTexto}`;
  const assinaturaEsperada = createHmac('sha256', segredo).update(payload).digest('hex');
  if (!comparacaoSegura(assinatura, assinaturaEsperada)) return null;

  const validoAte = Number(validoAteTexto);
  if (!Number.isFinite(validoAte) || Date.now() > validoAte) return null;

  return { documento };
}
