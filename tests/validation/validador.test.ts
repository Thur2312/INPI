import { describe, expect, it } from 'vitest';
import type { LinhaImportada } from '../../src/validation/importarPlanilha.js';
import { validarLinhas } from '../../src/validation/validador.js';

function linha(overrides: Partial<LinhaImportada['dados']> & { posicao: number }): LinhaImportada {
  const { posicao, ...dados } = overrides;
  return {
    posicao,
    dados: {
      cliente: null,
      titular_documento: '111.444.777-35',
      titular_nome: null,
      numero_processo: '940328100',
      objeto_peticao: 'TPH',
      prioridade: null,
      protocolos_ja_utilizados: 0,
      fila: 'PRINCIPAL',
      ...dados,
    },
  };
}

describe('validarLinhas', () => {
  it('valida uma linha correta', () => {
    const resultado = validarLinhas([linha({ posicao: 1 })]);
    expect(resultado).toHaveLength(1);
    expect(resultado[0]?.status).toBe('VALIDADO');
    expect(resultado[0]?.erroMensagem).toBeNull();
  });

  it('rejeita documento com dígito verificador inválido como PENDENCIA_DADOS', () => {
    const resultado = validarLinhas([linha({ posicao: 1, titular_documento: '11144477736' })]);
    expect(resultado[0]?.status).toBe('PENDENCIA_DADOS');
    expect(resultado[0]?.erroMensagem).toMatch(/dígito verificador inválido/);
  });

  it('rejeita numero_processo fora do formato como PENDENCIA_DADOS', () => {
    const resultado = validarLinhas([linha({ posicao: 1, numero_processo: '123' })]);
    expect(resultado[0]?.status).toBe('PENDENCIA_DADOS');
    expect(resultado[0]?.erroMensagem).toMatch(/fora do formato/);
  });

  it('mantém a 1ª ocorrência de numero_processo duplicado como candidata e rejeita só as repetições', () => {
    const resultado = validarLinhas([
      linha({ posicao: 1, numero_processo: '940328100' }),
      linha({ posicao: 2, numero_processo: '940328100', titular_documento: '11222333000181' }),
    ]);
    expect(resultado).toHaveLength(2);

    const primeira = resultado.find((r) => r.posicao === 1);
    const segunda = resultado.find((r) => r.posicao === 2);
    expect(primeira?.status).toBe('VALIDADO');
    expect(primeira?.erroMensagem).toBeNull();
    expect(segunda?.status).toBe('PENDENCIA_DADOS');
    expect(segunda?.erroMensagem).toMatch(/duplicado na planilha.*linha 1/);
  });

  it('com 3+ ocorrências do mesmo numero_processo, mantém só a 1ª e rejeita as demais', () => {
    const resultado = validarLinhas([
      linha({ posicao: 1, numero_processo: '940328100' }),
      linha({ posicao: 2, numero_processo: '940328100', titular_documento: '11222333000181' }),
      linha({ posicao: 3, numero_processo: '940328100', titular_documento: '22333444000162' }),
    ]);
    expect(resultado.filter((r) => r.status === 'VALIDADO')).toHaveLength(1);
    expect(resultado.find((r) => r.posicao === 1)?.status).toBe('VALIDADO');
    expect(resultado.filter((r) => r.status === 'PENDENCIA_DADOS')).toHaveLength(2);
  });

  it('não considera linhas com PENDENCIA_DADOS ao calcular o teto por titular', () => {
    // 10 válidas + 1 com documento inválido para o MESMO titular: a
    // inválida não deve "roubar" uma vaga de outra elegível por engano,
    // nem entrar na disputa do teto — ela já saiu por outro motivo.
    const validas = Array.from({ length: 10 }, (_, i) =>
      linha({ posicao: i + 1, numero_processo: `90000000${i}` }),
    );
    const invalida = linha({ posicao: 11, numero_processo: '900000099', titular_documento: '000' });
    const resultado = validarLinhas([...validas, invalida]);

    const validadas = resultado.filter((r) => r.status === 'VALIDADO');
    const pendenciaDados = resultado.filter((r) => r.status === 'PENDENCIA_DADOS');
    expect(validadas).toHaveLength(10);
    expect(pendenciaDados).toHaveLength(1);
  });

  it('marca como PENDENCIA_DADOS quando numero_processo já existe no banco (2ª importação)', () => {
    const resultado = validarLinhas(
      [linha({ posicao: 1, numero_processo: '940328100' })],
      new Set(['940328100']),
    );
    expect(resultado[0]?.status).toBe('PENDENCIA_DADOS');
    expect(resultado[0]?.erroMensagem).toMatch(/já existe no banco/);
  });

  it('numerosProcessoExistentes vazio (padrão) não afeta linhas novas', () => {
    const resultado = validarLinhas([linha({ posicao: 1, numero_processo: '940328100' })]);
    expect(resultado[0]?.status).toBe('VALIDADO');
  });

  it('resultado final vem ordenado por posicao', () => {
    const resultado = validarLinhas([
      linha({ posicao: 3, numero_processo: '900000003' }),
      linha({ posicao: 1, numero_processo: '900000001' }),
      linha({ posicao: 2, numero_processo: '900000002' }),
    ]);
    expect(resultado.map((r) => r.posicao)).toEqual([1, 2, 3]);
  });
});
