import { createHmac } from 'node:crypto';
import { comparacaoSegura } from './basicAuth.js';

/**
 * Token de sessão sem estado no servidor — carrega um "assunto" (documento
 * do cliente, ou uma string fixa tipo "dashboard" pra sessão de operador) e
 * a validade, assinados com HMAC. Quem não tem `segredo` não forja um
 * token válido. Compartilhado pelo portal do cliente (sessão por CNPJ/CPF)
 * e pelo painel interno (sessão por senha, ver src/dashboard/servidor.ts).
 */
export function assinarToken(assunto: string, segredo: string, validadeMs: number): string {
  const validoAte = Date.now() + validadeMs;
  const payload = `${assunto}.${validoAte}`;
  const assinatura = createHmac('sha256', segredo).update(payload).digest('hex');
  return Buffer.from(`${payload}.${assinatura}`, 'utf-8').toString('base64url');
}

export function verificarToken(token: string, segredo: string): { assunto: string } | null {
  let decodificado: string;
  try {
    decodificado = Buffer.from(token, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  const partes = decodificado.split('.');
  if (partes.length !== 3) return null;
  const [assunto, validoAteTexto, assinatura] = partes as [string, string, string];

  const payload = `${assunto}.${validoAteTexto}`;
  const assinaturaEsperada = createHmac('sha256', segredo).update(payload).digest('hex');
  if (!comparacaoSegura(assinatura, assinaturaEsperada)) return null;

  const validoAte = Number(validoAteTexto);
  if (!Number.isFinite(validoAte) || Date.now() > validoAte) return null;

  return { assunto };
}
