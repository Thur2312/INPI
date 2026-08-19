import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type NivelLog = 'info' | 'warn' | 'error';

export interface Logger {
  info(mensagem: string, dados?: Record<string, unknown>): void;
  warn(mensagem: string, dados?: Record<string, unknown>): void;
  error(mensagem: string, dados?: Record<string, unknown>): void;
}

const PLACEHOLDER = '***REDACTED***';

/**
 * Substitui qualquer ocorrência literal de um segredo (ex.: a senha do
 * INPI vinda do .env) em qualquer string do payload, recursivamente. Isso
 * vale mesmo que o segredo apareça embutido em outra string (ex.: uma
 * mensagem de erro que ecoou o corpo de um POST) — não é só um campo
 * "senha" que a gente evita logar, é uma varredura por valor.
 */
function redigir<T>(valor: T, segredos: readonly string[]): T {
  if (segredos.length === 0) return valor;

  if (typeof valor === 'string') {
    let resultado: string = valor;
    for (const segredo of segredos) {
      if (segredo.length === 0) continue;
      resultado = resultado.split(segredo).join(PLACEHOLDER);
    }
    return resultado as T;
  }

  if (Array.isArray(valor)) {
    const itens = valor as unknown[];
    const resultado: unknown[] = itens.map((v) => redigir(v, segredos));
    return resultado as T;
  }

  if (valor !== null && typeof valor === 'object') {
    const entradas = Object.entries(valor as Record<string, unknown>).map(([k, v]) => [
      k,
      redigir(v, segredos),
    ]);
    return Object.fromEntries(entradas) as T;
  }

  return valor;
}

/**
 * Logger JSONL (uma linha JSON por evento — fácil de fazer `tail -f` e
 * também de processar depois). `segredos` é a lista de valores literais
 * (normalmente vindos de env sensível, como INPI_SENHA) que nunca podem
 * chegar ao arquivo.
 */
export function criarLogger(caminhoArquivo: string, segredos: readonly string[] = []): Logger {
  const pasta = dirname(caminhoArquivo);
  if (!existsSync(pasta)) {
    mkdirSync(pasta, { recursive: true });
  }

  function escrever(nivel: NivelLog, mensagem: string, dados?: Record<string, unknown>): void {
    const linha = {
      timestamp: new Date().toISOString(),
      nivel,
      mensagem: redigir(mensagem, segredos),
      ...(dados ? redigir(dados, segredos) : {}),
    };
    appendFileSync(caminhoArquivo, `${JSON.stringify(linha)}\n`, 'utf-8');
  }

  return {
    info: (mensagem, dados) => escrever('info', mensagem, dados),
    warn: (mensagem, dados) => escrever('warn', mensagem, dados),
    error: (mensagem, dados) => escrever('error', mensagem, dados),
  };
}
