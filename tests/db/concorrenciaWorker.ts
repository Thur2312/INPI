// Worker de teste que roda em thread real (worker_threads) e chama a
// função de produção `reivindicarProximo` de verdade — não uma cópia da
// lógica. É carregado com `execArgv: ['--import', 'tsx/esm']` (ver
// queue.concorrencia.test.ts) para o Node conseguir importar TypeScript
// dentro da thread.
import { parentPort, workerData } from 'node:worker_threads';
import { abrirConexao } from '../../src/db/connection.js';
import { reivindicarProximo } from '../../src/db/queue.js';

const { caminhoDb, workerId } = workerData as { caminhoDb: string; workerId: string };

const db = abrirConexao(caminhoDb);

const claimados: number[] = [];
for (;;) {
  const processo = reivindicarProximo(db, workerId);
  if (processo === null) break;
  claimados.push(processo.id);
}

db.close();
parentPort?.postMessage(claimados);
