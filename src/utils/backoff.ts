/**
 * Backoff exponencial com jitter: dobra a cada tentativa (1ª falha = base,
 * 2ª = 2x, 3ª = 4x...), com um fator aleatório de 50%–100% do valor
 * calculado para não fazer vários workers colidirem no mesmo instante ao
 * reagir a um erro simultâneo (ex.: todos derrubados pela mesma queda de
 * sessão). Sempre limitado por `maxMs`.
 */
export function calcularBackoffMs(tentativa: number, baseMs = 1000, maxMs = 30_000): number {
  const exponencial = baseMs * 2 ** Math.max(0, tentativa - 1);
  const comJitter = exponencial * (0.5 + Math.random() * 0.5);
  return Math.min(comJitter, maxMs);
}
