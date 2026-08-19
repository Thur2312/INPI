import { describe, expect, it } from 'vitest';
import { calcularBackoffMs } from '../../src/utils/backoff.js';

describe('calcularBackoffMs', () => {
  it('cresce a cada tentativa (mesmo com jitter, o teto de cada tentativa sobe)', () => {
    // Roda várias amostras porque tem aleatoriedade (jitter) — compara o
    // máximo observado de cada tentativa, que deve respeitar a progressão
    // exponencial mesmo com o fator aleatório de 50%-100%.
    const amostras = (tentativa: number) =>
      Array.from({ length: 50 }, () => calcularBackoffMs(tentativa, 1000, 60_000));

    const maxTentativa1 = Math.max(...amostras(1));
    const maxTentativa2 = Math.max(...amostras(2));
    const maxTentativa3 = Math.max(...amostras(3));

    expect(maxTentativa1).toBeLessThanOrEqual(1000);
    expect(maxTentativa2).toBeLessThanOrEqual(2000);
    expect(maxTentativa3).toBeLessThanOrEqual(4000);
    expect(maxTentativa3).toBeGreaterThan(maxTentativa1);
  });

  it('nunca passa do teto configurado, mesmo em tentativas altas', () => {
    for (let i = 0; i < 30; i += 1) {
      expect(calcularBackoffMs(20, 1000, 30_000)).toBeLessThanOrEqual(30_000);
    }
  });

  it('nunca é negativo ou zero', () => {
    for (let i = 0; i < 30; i += 1) {
      expect(calcularBackoffMs(1, 1000, 30_000)).toBeGreaterThan(0);
    }
  });
});
