import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { liberarOperacao } from '../../src/db/operacao.js';

const WORKER_SCRIPT = fileURLToPath(new URL('./concorrenciaWorkerBootstrap.mjs', import.meta.url));
const TOTAL_PROCESSOS = 150;
const TOTAL_WORKERS = 8;

let pastaTemp: string;
let caminhoDb: string;

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-fila-concorrencia-'));
  caminhoDb = join(pastaTemp, 'teste.db');

  const db = abrirConexao(caminhoDb);
  migrar(db);
  liberarOperacao(db, '13');

  const inserir = db.prepare(`
    INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
    VALUES (@posicao, 'PRINCIPAL', @doc, @numero, 'TPH', 'AGUARDANDO_ABERTURA')
  `);
  const inserirTodos = db.transaction((total: number) => {
    for (let i = 1; i <= total; i += 1) {
      inserir.run({ posicao: i, doc: `${10000000000 + i}`, numero: `${900000000 + i}` });
    }
  });
  inserirTodos(TOTAL_PROCESSOS);

  db.close();
});

afterEach(() => {
  rmSync(pastaTemp, { recursive: true, force: true });
});

function rodarWorker(workerId: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, { workerData: { caminhoDb, workerId } });
    worker.once('message', (claimados: number[]) => resolve(claimados));
    worker.once('error', reject);
  });
}

describe('claim atômico da fila sob concorrência real', () => {
  it('nunca entrega o mesmo processo a dois workers, e reivindica todos exatamente uma vez', async () => {
    const workerIds = Array.from({ length: TOTAL_WORKERS }, (_, i) => `worker-${i}`);
    const resultados = await Promise.all(workerIds.map(rodarWorker));

    const todosClaimados = resultados.flat();
    const idsUnicos = new Set(todosClaimados);

    // Nenhuma duplicata entre os workers: se o claim atômico falhasse, o
    // mesmo id apareceria na lista de mais de um worker e o Set encolheria.
    expect(idsUnicos.size).toBe(todosClaimados.length);

    // Todos os processos inseridos foram reivindicados por alguém — a fila
    // não perdeu item nem travou antes do fim.
    expect(idsUnicos.size).toBe(TOTAL_PROCESSOS);

    const db = abrirConexao(caminhoDb);
    const contagem = db
      .prepare(`SELECT COUNT(*) AS total FROM processos WHERE status = 'GRU_EM_PROCESSAMENTO'`)
      .get() as { total: number };
    expect(contagem.total).toBe(TOTAL_PROCESSOS);

    const tentativasErradas = db
      .prepare(`SELECT COUNT(*) AS total FROM processos WHERE tentativas <> 1`)
      .get() as { total: number };
    expect(tentativasErradas.total).toBe(0);

    db.close();
  }, 20_000);
});
