import { describe, expect, it } from 'vitest';
import { aplicarTetoPorTitular, type CandidatoProcesso } from '../../src/domain/regrasNegocio.js';

function candidato(overrides: Partial<CandidatoProcesso>): CandidatoProcesso {
  return {
    posicao: 1,
    fila: 'PRINCIPAL',
    cliente: null,
    titularDocumento: '11144477735',
    titularNome: null,
    numeroProcesso: '900000001',
    objetoPeticao: 'TPH',
    prioridade: null,
    protocolosJaUtilizados: 0,
    ...overrides,
  };
}

describe('aplicarTetoPorTitular', () => {
  it('libera tudo quando o titular está dentro do teto', () => {
    const candidatos = Array.from({ length: 5 }, (_, i) => candidato({ posicao: i + 1 }));
    const resultado = aplicarTetoPorTitular(candidatos);
    expect(resultado.every((r) => r.elegivel)).toBe(true);
  });

  it('bloqueia exatamente o excedente quando passa de 10, priorizando por `prioridade` (menor primeiro)', () => {
    const candidatos = Array.from({ length: 12 }, (_, i) =>
      candidato({ posicao: i + 1, numeroProcesso: `90000${i}`, prioridade: 12 - i }),
    );
    const resultado = aplicarTetoPorTitular(candidatos);

    const elegiveis = resultado.filter((r) => r.elegivel);
    const bloqueados = resultado.filter((r) => !r.elegivel);
    expect(elegiveis).toHaveLength(10);
    expect(bloqueados).toHaveLength(2);

    // prioridade = 12 - i: menor prioridade numérica é a mais alta i (posicao 11 e 12 têm prioridade 1 e 2)
    // os dois com MAIOR valor de prioridade (menos prioritários) ficam de fora: posicao 1 (prioridade 12) e posicao 2 (prioridade 11)
    const posicoesBloqueadas = bloqueados.map((r) => r.posicao).sort((a, b) => a - b);
    expect(posicoesBloqueadas).toEqual([1, 2]);
    expect(bloqueados[0]?.motivoPendencia).toMatch(/limite de 10/);
  });

  it('considera protocolos_ja_utilizados ao calcular o teto disponível', () => {
    const candidatos = Array.from({ length: 4 }, (_, i) =>
      candidato({ posicao: i + 1, numeroProcesso: `90000${i}`, protocolosJaUtilizados: 8 }),
    );
    const resultado = aplicarTetoPorTitular(candidatos);
    const elegiveis = resultado.filter((r) => r.elegivel);
    expect(elegiveis).toHaveLength(2); // disponível = 10 - 8
  });

  it('usa a posição da planilha como desempate determinístico quando prioridade é ausente', () => {
    const candidatos = Array.from({ length: 11 }, (_, i) =>
      candidato({ posicao: i + 1, numeroProcesso: `90000${i}`, prioridade: null }),
    );
    const resultado = aplicarTetoPorTitular(candidatos);
    const bloqueado = resultado.find((r) => !r.elegivel);
    expect(bloqueado?.posicao).toBe(11); // último da planilha fica de fora
    expect(bloqueado?.motivoPendencia).toMatch(/ordem de planilha/);
  });

  it('não mistura titulares diferentes no mesmo teto', () => {
    const candidatos = [
      ...Array.from({ length: 10 }, (_, i) =>
        candidato({ posicao: i + 1, numeroProcesso: `90000${i}`, titularDocumento: '11144477735' }),
      ),
      candidato({ posicao: 11, numeroProcesso: '9000099', titularDocumento: '11222333000181' }),
    ];
    const resultado = aplicarTetoPorTitular(candidatos);
    expect(resultado.every((r) => r.elegivel)).toBe(true);
  });

  it('marca PENDENCIA_DADOS (via motivo) quando protocolos_ja_utilizados é inconsistente para o mesmo titular', () => {
    const candidatos = [
      candidato({ posicao: 1, numeroProcesso: '9000001', protocolosJaUtilizados: 2 }),
      candidato({ posicao: 2, numeroProcesso: '9000002', protocolosJaUtilizados: 5 }),
    ];
    const resultado = aplicarTetoPorTitular(candidatos);
    expect(resultado.every((r) => !r.elegivel)).toBe(true);
    expect(resultado[0]?.motivoPendencia).toMatch(/inconsistentes/);
  });
});
