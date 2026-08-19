import type { STATUS_ERRO_DEFINITIVO, STATUS_ERRO_TEMPORARIO } from '../domain/types.js';

type TipoErroDefinitivo = (typeof STATUS_ERRO_DEFINITIVO)[number];
type TipoErroTemporario = (typeof STATUS_ERRO_TEMPORARIO)[number];

/**
 * Toda exceção lançada pelo adapter carrega um `tipo` que bate 1:1 com os
 * status de exceção do domínio (`src/domain/types.ts`) — o orquestrador
 * (Etapa 3) usa esse campo para decidir retry vs. definitivo vs. pausa
 * global, sem precisar de um `instanceof` por classe.
 */
export abstract class ErroInpi extends Error {
  abstract readonly tipo:
    | TipoErroDefinitivo
    | TipoErroTemporario
    | 'ERRO_OBJETO_INDISPONIVEL'
    | 'ERRO_CAPTCHA'
    | 'ERRO_DESCONHECIDO';
}

export class ClienteNaoEncontradoError extends ErroInpi {
  readonly tipo = 'ERRO_CLIENTE_NAO_ENCONTRADO';
  constructor(readonly documentoBuscado: string) {
    super(`nenhum cliente encontrado para o documento buscado (${documentoBuscado})`);
    this.name = 'ClienteNaoEncontradoError';
  }
}

export class ClienteAmbiguoError extends ErroInpi {
  readonly tipo = 'ERRO_CLIENTE_AMBIGUO';
  constructor(
    readonly documentoBuscado: string,
    readonly quantidadeEncontrada: number,
  ) {
    super(
      `${quantidadeEncontrada} clientes encontrados para o documento buscado (${documentoBuscado}) — o documento vem mascarado na tela do INPI, então não há como o robô decidir sozinho qual é o certo`,
    );
    this.name = 'ClienteAmbiguoError';
  }
}

/**
 * Falha de operação inteira, não de um processo específico: se a
 * modalidade não está no dropdown, o problema é da cota/quadrimestre, não
 * do registro que estava sendo processado no momento. O orquestrador deve
 * pausar a fila inteira, não descartar só este processo.
 */
export class ObjetoPeticaoIndisponivelError extends ErroInpi {
  readonly tipo = 'ERRO_OBJETO_INDISPONIVEL';
  constructor(
    readonly textoBuscado: string,
    readonly opcoesDisponiveis: readonly string[],
  ) {
    super(
      `objeto da petição "${textoBuscado}" não encontrado no dropdown. Opções disponíveis: ${
        opcoesDisponiveis.length > 0 ? opcoesDisponiveis.join(', ') : '(nenhuma)'
      }`,
    );
    this.name = 'ObjetoPeticaoIndisponivelError';
  }
}

export class ValorInesperadoError extends ErroInpi {
  readonly tipo = 'ERRO_VALOR_INESPERADO';
  constructor(
    readonly valorEsperado: number,
    readonly valorEncontrado: number,
  ) {
    super(
      `valor da guia (R$ ${valorEncontrado.toFixed(2)}) diferente do esperado (R$ ${valorEsperado.toFixed(2)}) — serviço cancelado antes de gerar o boleto`,
    );
    this.name = 'ValorInesperadoError';
  }
}

export class SessaoInpiError extends ErroInpi {
  readonly tipo = 'ERRO_SESSAO';
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'SessaoInpiError';
  }
}

export class TimeoutInpiError extends ErroInpi {
  readonly tipo = 'ERRO_TIMEOUT';
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'TimeoutInpiError';
  }
}

/**
 * Nunca tentar resolver — só existe para falhar rápido e com mensagem
 * clara. Ver aviso em `selectors.ts` sobre CAPTCHA_SELETORES não serem
 * confirmados contra o sistema real.
 */
export class CaptchaDetectadoError extends ErroInpi {
  readonly tipo = 'ERRO_CAPTCHA';
  constructor(readonly seletorDetectado: string) {
    super(
      `captcha detectado na tela (${seletorDetectado}) — parando sem tentar resolver, conforme exigido`,
    );
    this.name = 'CaptchaDetectadoError';
  }
}

/**
 * Erro de uso, não de operação: o chamador pediu uma janela de busca que o
 * INPI recusaria antes de qualquer interação com a página. Não estende
 * `ErroInpi` — não existe um `processo` associado a este erro, é uma
 * guarda de pré-voo em `consultarGrusDoCliente`.
 */
export class PeriodoConsultaInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'PeriodoConsultaInvalidoError';
  }
}

export class ErroDesconhecidoInpi extends ErroInpi {
  readonly tipo = 'ERRO_DESCONHECIDO';
  constructor(
    mensagem: string,
    readonly causa?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroDesconhecidoInpi';
  }
}
