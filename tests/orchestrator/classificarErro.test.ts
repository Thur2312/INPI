import { describe, expect, it } from 'vitest';
import {
  CaptchaDetectadoError,
  ClienteAmbiguoError,
  ClienteNaoEncontradoError,
  ErroDesconhecidoInpi,
  ObjetoPeticaoIndisponivelError,
  SessaoInpiError,
  TimeoutInpiError,
} from '../../src/inpi/erros.js';
import {
  classificarErro,
  mensagemDoErro,
  statusDoErro,
} from '../../src/orchestrator/classificarErro.js';

describe('classificarErro', () => {
  it('objeto indisponível e captcha são PAUSA_GLOBAL — problema da operação, não do processo', () => {
    expect(classificarErro(new ObjetoPeticaoIndisponivelError('x', []))).toBe('PAUSA_GLOBAL');
    expect(classificarErro(new CaptchaDetectadoError('iframe'))).toBe('PAUSA_GLOBAL');
  });

  it('cliente não encontrado e ambíguo são DEFINITIVO — retry não muda o dado', () => {
    expect(classificarErro(new ClienteNaoEncontradoError('doc'))).toBe('DEFINITIVO');
    expect(classificarErro(new ClienteAmbiguoError('doc', 2))).toBe('DEFINITIVO');
  });

  it('sessão caída, timeout e erros desconhecidos são RETRY', () => {
    expect(classificarErro(new SessaoInpiError('caiu'))).toBe('RETRY');
    expect(classificarErro(new TimeoutInpiError('demorou'))).toBe('RETRY');
    expect(classificarErro(new ErroDesconhecidoInpi('sei lá'))).toBe('RETRY');
    expect(classificarErro(new Error('qualquer coisa'))).toBe('RETRY');
  });

  it('o TimeoutError nativo do Playwright (não o nosso) também é RETRY', () => {
    const erroPlaywright = new Error('Timeout 30000ms exceeded');
    erroPlaywright.name = 'TimeoutError';
    expect(classificarErro(erroPlaywright)).toBe('RETRY');
  });
});

describe('statusDoErro', () => {
  it('usa o campo tipo do ErroInpi', () => {
    expect(statusDoErro(new ClienteNaoEncontradoError('doc'))).toBe('ERRO_CLIENTE_NAO_ENCONTRADO');
    expect(statusDoErro(new CaptchaDetectadoError('x'))).toBe('ERRO_CAPTCHA');
  });

  it('cai para ERRO_DESCONHECIDO em erros genéricos', () => {
    expect(statusDoErro(new Error('boom'))).toBe('ERRO_DESCONHECIDO');
    expect(statusDoErro('string crua')).toBe('ERRO_DESCONHECIDO');
  });
});

describe('mensagemDoErro', () => {
  it('extrai a message de um Error', () => {
    expect(mensagemDoErro(new Error('deu ruim'))).toBe('deu ruim');
  });

  it('converte valores não-Error para string', () => {
    expect(mensagemDoErro('deu ruim direto')).toBe('deu ruim direto');
  });
});
