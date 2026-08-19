import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Abre a conexão SQLite com os pragmas necessários para concorrência segura:
 *
 * - `journal_mode = WAL`: leitores não bloqueiam escritores e vice-versa
 *   (Write-Ahead Log). Sem isso, dois workers batendo no banco ao mesmo
 *   tempo tomariam "database is locked" com muito mais frequência.
 * - `busy_timeout`: quando o banco está momentaneamente ocupado por outra
 *   transação, o SQLite espera até N ms antes de falhar, em vez de
 *   estourar erro na hora. Suaviza a corrida entre os workers.
 * - `foreign_keys = ON`: garante integridade referencial (eventos → processos).
 */
export function abrirConexao(caminho: string): Database.Database {
  const pasta = dirname(caminho);
  if (!existsSync(pasta)) {
    mkdirSync(pasta, { recursive: true });
  }

  const db = new Database(caminho);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
