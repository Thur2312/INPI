import { describe, expect, it, vi } from 'vitest';
import { verificarAbertura } from '../../src/orchestrator/verificadorAbertura.js';
import type { Logger } from '../../src/utils/logger.js';

function criarLoggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('verificarAbertura', () => {
  it('retorna na hora sem fazer polling se a operação já está RODANDO', async () => {
    const objetoPeticaoDisponivel = vi.fn();
    const liberarOperacao = vi.fn();

    await verificarAbertura(
      { objetoPeticaoDisponivel },
      {
        obterOperacao: () => ({ status: 'RODANDO' }),
        liberarOperacao,
        registrarAlertaCategoria: vi.fn(),
      },
      'TPH',
      '11144477735',
      '940328100',
      { logger: criarLoggerFalso() },
    );

    expect(objetoPeticaoDisponivel).not.toHaveBeenCalled();
    expect(liberarOperacao).not.toHaveBeenCalled();
  });

  it('libera a operação assim que o objeto aparece, registrando o value encontrado', async () => {
    const objetoPeticaoDisponivel = vi
      .fn()
      .mockResolvedValueOnce({ encontrado: false, value: null, opcoesAtuais: ['TPH'] })
      .mockResolvedValueOnce({ encontrado: false, value: null, opcoesAtuais: ['TPH'] })
      .mockResolvedValueOnce({
        encontrado: true,
        value: '14',
        opcoesAtuais: ['TPH', 'Plataforma de Mercado Virtual'],
      });
    const liberarOperacao = vi.fn();
    const status = 'AGUARDANDO_ABERTURA';

    await verificarAbertura(
      { objetoPeticaoDisponivel },
      {
        obterOperacao: () => ({ status }),
        liberarOperacao,
        registrarAlertaCategoria: vi.fn(),
      },
      'Plataforma de Mercado Virtual',
      '11144477735',
      '940328100',
      { logger: criarLoggerFalso(), intervaloMinMs: 1, intervaloMaxMs: 2 },
    );

    expect(objetoPeticaoDisponivel).toHaveBeenCalledTimes(3);
    expect(liberarOperacao).toHaveBeenCalledTimes(1);
    expect(liberarOperacao).toHaveBeenCalledWith('14');
  });

  it('continua tentando (não trava) quando a checagem lança erro, e ainda assim libera quando funcionar', async () => {
    const objetoPeticaoDisponivel = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout de rede'))
      .mockResolvedValueOnce({ encontrado: true, value: '13', opcoesAtuais: ['TPH'] });
    const liberarOperacao = vi.fn();
    const logger = criarLoggerFalso();

    await verificarAbertura(
      { objetoPeticaoDisponivel },
      {
        obterOperacao: () => ({ status: 'AGUARDANDO_ABERTURA' }),
        liberarOperacao,
        registrarAlertaCategoria: vi.fn(),
      },
      'TPH',
      '11144477735',
      '940328100',
      { logger, intervaloMinMs: 1, intervaloMaxMs: 2 },
    );

    expect(liberarOperacao).toHaveBeenCalledTimes(1);
    expect(liberarOperacao).toHaveBeenCalledWith('13');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('para quando o sinal de parada é acionado, mesmo sem nunca ter encontrado o objeto', async () => {
    const objetoPeticaoDisponivel = vi
      .fn()
      .mockResolvedValue({ encontrado: false, value: null, opcoesAtuais: [] });
    const liberarOperacao = vi.fn();
    const sinal = { parar: false };

    setTimeout(() => {
      sinal.parar = true;
    }, 5);

    await verificarAbertura(
      { objetoPeticaoDisponivel },
      {
        obterOperacao: () => ({ status: 'AGUARDANDO_ABERTURA' }),
        liberarOperacao,
        registrarAlertaCategoria: vi.fn(),
      },
      'TPH',
      '11144477735',
      '940328100',
      { logger: criarLoggerFalso(), intervaloMinMs: 1, intervaloMaxMs: 2, sinal },
    );

    expect(liberarOperacao).not.toHaveBeenCalled();
  });

  it('avisa (sem escolher sozinho) quando uma opção nova aparece e não bate com o texto configurado', async () => {
    const objetoPeticaoDisponivel = vi
      .fn()
      // 1ª checagem: define a linha de base (nada aqui ainda é "novo").
      .mockResolvedValueOnce({ encontrado: false, value: null, opcoesAtuais: ['Selecione'] })
      // 2ª: "Ação na Justiça" aparece — não bate com o texto configurado.
      .mockResolvedValueOnce({
        encontrado: false,
        value: null,
        opcoesAtuais: ['Selecione', 'Ação na Justiça'],
      })
      // 3ª: mesma opção de novo — não deve gerar um segundo alerta.
      .mockResolvedValueOnce({
        encontrado: false,
        value: null,
        opcoesAtuais: ['Selecione', 'Ação na Justiça'],
      });
    const liberarOperacao = vi.fn();
    const registrarAlertaCategoria = vi.fn();
    const logger = criarLoggerFalso();
    const sinal = { parar: false };

    setTimeout(() => {
      sinal.parar = true;
    }, 15);

    await verificarAbertura(
      { objetoPeticaoDisponivel },
      {
        obterOperacao: () => ({ status: 'AGUARDANDO_ABERTURA' }),
        liberarOperacao,
        registrarAlertaCategoria,
      },
      'Plataforma de Mercado Virtual',
      '11144477735',
      '940328100',
      { logger, intervaloMinMs: 1, intervaloMaxMs: 2, sinal },
    );

    expect(liberarOperacao).not.toHaveBeenCalled();
    expect(registrarAlertaCategoria).toHaveBeenCalledTimes(1);
    expect(registrarAlertaCategoria).toHaveBeenCalledWith(['Ação na Justiça']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('opções novas'),
      expect.objectContaining({ opcoesNovas: ['Ação na Justiça'] }),
    );
  });
});
