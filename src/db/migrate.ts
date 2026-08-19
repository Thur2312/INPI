import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { abrirConexao } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASTA_MIGRATIONS = join(__dirname, 'migrations');

/**
 * Aplica migrações SQL pendentes, em ordem, dentro de uma transação por
 * arquivo. Migrações já aplicadas ficam registradas em `_migrations` e
 * nunca são reexecutadas — permite rodar `migrate` quantas vezes quiser
 * (idempotente) sem duplicar schema.
 */
export function migrar(db: Database.Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      nome TEXT PRIMARY KEY,
      aplicada_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const linhas = db.prepare('SELECT nome FROM _migrations').all() as { nome: string }[];
  const jaAplicadas = new Set(linhas.map((r) => r.nome));

  const arquivos = readdirSync(PASTA_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const executadas: string[] = [];

  for (const arquivo of arquivos) {
    if (jaAplicadas.has(arquivo)) continue;

    const sql = readFileSync(join(PASTA_MIGRATIONS, arquivo), 'utf-8');
    const aplicar = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (nome) VALUES (?)').run(arquivo);
    });
    aplicar();
    executadas.push(arquivo);
  }

  return executadas;
}

// Permite rodar `npm run migrate` diretamente.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const caminho = process.env['DB_PATH'] ?? './data/inpi.db';
  const db = abrirConexao(caminho);
  const executadas = migrar(db);
  if (executadas.length === 0) {
    console.log('Nenhuma migração pendente.');
  } else {
    console.log(`Migrações aplicadas: ${executadas.join(', ')}`);
  }
  db.close();
}
