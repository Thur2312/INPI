import { describe, expect, it } from 'vitest';
import { parseArgumentosCli } from '../../src/orchestrator/cli.js';

describe('parseArgumentosCli', () => {
  it('sem argumentos: dryRun falso, limite nulo', () => {
    expect(parseArgumentosCli([])).toEqual({ dryRun: false, limite: null });
  });

  it('--dry-run --limite=3: reconhece as duas flags', () => {
    expect(parseArgumentosCli(['--dry-run', '--limite=3'])).toEqual({
      dryRun: true,
      limite: 3,
    });
  });

  it('ordem das flags não importa', () => {
    expect(parseArgumentosCli(['--limite=5', '--dry-run'])).toEqual({
      dryRun: true,
      limite: 5,
    });
  });

  it('--limite=N sem --dry-run é aceito (não tem efeito na execução real, mas o parser não recusa)', () => {
    expect(parseArgumentosCli(['--limite=10'])).toEqual({ dryRun: false, limite: 10 });
  });

  it('--dry-run sem --limite lança erro explícito', () => {
    expect(() => parseArgumentosCli(['--dry-run'])).toThrow(/--limite/);
  });

  it('--limite=0 é rejeitado (precisa ser positivo)', () => {
    expect(() => parseArgumentosCli(['--dry-run', '--limite=0'])).toThrow();
  });

  it('--limite=abc é rejeitado (não é inteiro)', () => {
    expect(() => parseArgumentosCli(['--dry-run', '--limite=abc'])).toThrow();
  });

  it('--limite=-1 é rejeitado (negativo)', () => {
    expect(() => parseArgumentosCli(['--dry-run', '--limite=-1'])).toThrow();
  });

  it('--limite=3.5 é rejeitado (não é inteiro)', () => {
    expect(() => parseArgumentosCli(['--dry-run', '--limite=3.5'])).toThrow();
  });

  it('argumento desconhecido lança erro', () => {
    expect(() => parseArgumentosCli(['--modo-turbo'])).toThrow(/não reconhecido/);
  });
});
