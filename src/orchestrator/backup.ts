import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

const PREFIXO = 'inpi-backup-';

/**
 * Copiar `data/inpi.db` com `fs.copyFile` seria arriscado em modo WAL: o
 * arquivo principal pode não ter os commits mais recentes (parte do
 * estado vive no `-wal`), e não há garantia de consistência entre os
 * arquivos sem coordenar locks manualmente. `db.backup()` usa a Online
 * Backup API do SQLite — sempre um snapshot consistente, mesmo com o
 * banco em uso.
 */
async function copiarAgora(
  db: Database.Database,
  pastaDestino: string,
  logger: Logger,
): Promise<void> {
  await mkdir(pastaDestino, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = join(pastaDestino, `${PREFIXO}${timestamp}.db`);

  try {
    await db.backup(destino);
    logger.info('backup do banco realizado', { destino });
  } catch (erro) {
    logger.error('falha ao fazer backup do banco', {
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }
}

export async function limparBackupsAntigos(
  pastaDestino: string,
  manterUltimos: number,
): Promise<void> {
  const arquivos = (await readdir(pastaDestino)).filter((f) => f.startsWith(PREFIXO));
  if (arquivos.length <= manterUltimos) return;

  const comData = await Promise.all(
    arquivos.map(async (nome) => {
      const caminho = join(pastaDestino, nome);
      const info = await stat(caminho);
      return { caminho, mtimeMs: info.mtimeMs };
    }),
  );

  comData.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const paraRemover = comData.slice(manterUltimos);
  await Promise.all(paraRemover.map((f) => unlink(f.caminho)));
}

/**
 * Inicia o backup periódico (backup imediato + a cada `intervaloMinutos`).
 * Retorna uma função para parar o intervalo no encerramento da operação.
 */
export function iniciarBackupPeriodico(
  db: Database.Database,
  pastaDestino: string,
  intervaloMinutos: number,
  logger: Logger,
  manterUltimos = 20,
): () => void {
  const executar = () => {
    // `.catch` aqui não é opcional: sem ele, qualquer falha na rotação
    // (ex.: pasta removida por fora) vira uma promise rejeitada sem
    // handler — em Node isso pode derrubar o processo inteiro no meio da
    // operação, por causa de uma limpeza de backup antigo que nem é
    // crítica.
    void copiarAgora(db, pastaDestino, logger)
      .then(() => limparBackupsAntigos(pastaDestino, manterUltimos))
      .catch((erro: unknown) => {
        logger.error('falha ao rotacionar backups antigos', {
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      });
  };

  executar();
  const intervalId = setInterval(executar, intervaloMinutos * 60 * 1000);

  return () => clearInterval(intervalId);
}
