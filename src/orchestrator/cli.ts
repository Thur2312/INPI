/**
 * `limite` é obrigatório sempre que `dryRun` é `true` (a própria checagem
 * abaixo garante isso em runtime) — o union discriminado deixa o chamador
 * usar `argumentos.limite` como `number` sem assertion depois de checar
 * `dryRun`.
 */
export type ArgumentosCli =
  | { dryRun: true; limite: number }
  | { dryRun: false; limite: number | null };

/**
 * Parser mínimo de `process.argv` — só as duas flags que o CLI de operação
 * precisa (`--dry-run`, `--limite=N`), sem trazer uma lib externa para
 * isso. Falha rápido em vez de silenciosamente ignorar um argumento mal
 * formado: no dia da operação, um erro de digitação no `--limite` não pode
 * virar "rodou a fila inteira sem querer".
 */
export function parseArgumentosCli(argv: readonly string[]): ArgumentosCli {
  let dryRun = false;
  let limite: number | null = null;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--limite=')) {
      const bruto = arg.slice('--limite='.length);
      const valor = Number.parseInt(bruto, 10);
      if (!Number.isFinite(valor) || valor <= 0 || String(valor) !== bruto) {
        throw new Error(`--limite deve ser um inteiro positivo, recebido: "${bruto}"`);
      }
      limite = valor;
      continue;
    }

    throw new Error(`argumento não reconhecido: "${arg}"`);
  }

  if (dryRun) {
    if (limite === null) {
      throw new Error(
        '--dry-run exige --limite=N explícito (ex.: --dry-run --limite=3) — evita rodar o ensaio contra a fila inteira sem querer.',
      );
    }
    return { dryRun: true, limite };
  }

  return { dryRun: false, limite };
}
