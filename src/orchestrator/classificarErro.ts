import {
  CaptchaDetectadoError,
  ClienteAmbiguoError,
  ClienteNaoEncontradoError,
  ObjetoPeticaoIndisponivelError,
} from '../inpi/erros.js';

export type Classificacao = 'PAUSA_GLOBAL' | 'RETRY' | 'DEFINITIVO';

/**
 * Decide o que fazer com um erro vindo do adapter. Três categorias:
 *
 * - `PAUSA_GLOBAL`: o problema é da operação inteira, não do processo que
 *   estava sendo tentado (cota fechou, captcha apareceu). Pausa a fila
 *   inteira e devolve o processo — ele não tem culpa de nada.
 * - `DEFINITIVO`: o dado está errado (cliente não existe, documento
 *   ambíguo). Retentar não muda o resultado — vai pro status de erro na
 *   hora, independente de quantas tentativas sobraram.
 * - `RETRY`: pode ser transitório (sessão caiu, timeout, erro
 *   desconhecido). Tenta de novo com backoff, respeitando o teto de
 *   tentativas do processo — nunca loop infinito.
 *
 * Erros desconhecidos (nem `ErroInpi`, nem o `TimeoutError` nativo do
 * Playwright) entram como RETRY: mais seguro dar uma segunda chance a algo
 * que pode ser um problema de rede passageiro do que descartar o processo
 * de cara — o teto de tentativas já garante que isso não vira loop eterno.
 */
export function classificarErro(erro: unknown): Classificacao {
  if (erro instanceof ObjetoPeticaoIndisponivelError || erro instanceof CaptchaDetectadoError) {
    return 'PAUSA_GLOBAL';
  }
  if (erro instanceof ClienteNaoEncontradoError || erro instanceof ClienteAmbiguoError) {
    return 'DEFINITIVO';
  }
  return 'RETRY';
}

/** Extrai um `status` de banco a partir do erro — usa `.tipo` quando existe (ErroInpi), senão ERRO_DESCONHECIDO. */
export function statusDoErro(erro: unknown): string {
  if (erro && typeof erro === 'object' && 'tipo' in erro && typeof erro.tipo === 'string') {
    return erro.tipo;
  }
  return 'ERRO_DESCONHECIDO';
}

export function mensagemDoErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return String(erro);
}
