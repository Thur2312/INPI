import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { iniciarBackupPeriodico, limparBackupsAntigos } from '../../src/orchestrator/backup.js';
import type { Logger } from '../../src/utils/logger.js';

function criarLoggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let pastaTemp: string;
let db: Database.Database;
let pastaBackup: string;

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-backup-'));
  db = abrirConexao(join(pastaTemp, 'origem.db'));
  migrar(db);
  pastaBackup = join(pastaTemp, 'backups');
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

function arquivosDeBackup(): string[] {
  if (!existsSync(pastaBackup)) return [];
  return readdirSync(pastaBackup).filter((f) => f.startsWith('inpi-backup-'));
}

describe('iniciarBackupPeriodico', () => {
  it('faz um backup imediato ao iniciar, consistente e restaurável', async () => {
    const parar = iniciarBackupPeriodico(db, pastaBackup, 60, criarLoggerFalso());
    // o backup roda de forma assíncrona (não bloqueia o intervalo) — dá um tick pra ele terminar
    await new Promise((resolve) => setTimeout(resolve, 100));
    parar();

    const arquivos = arquivosDeBackup();
    expect(arquivos).toHaveLength(1);

    const dbRestaurado = abrirConexao(join(pastaBackup, arquivos[0]!));
    const tabelas = dbRestaurado
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processos'`)
      .get();
    expect(tabelas).toBeDefined();
    dbRestaurado.close();
  });

  it('mantém só os N backups mais recentes (rotação)', async () => {
    const parar = iniciarBackupPeriodico(db, pastaBackup, 60, criarLoggerFalso(), 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    parar();

    // Simula backups "antigos" de execuções anteriores, todos antes do de agora.
    const { copyFileSync, utimesSync } = await import('node:fs');
    const original = join(pastaBackup, arquivosDeBackup()[0]!);
    for (let i = 0; i < 3; i += 1) {
      const antigo = join(pastaBackup, `inpi-backup-fake-${i}.db`);
      copyFileSync(original, antigo);
      const dataAntiga = new Date(Date.now() - (i + 1) * 60_000);
      utimesSync(antigo, dataAntiga, dataAntiga);
    }

    await limparBackupsAntigos(pastaBackup, 2);

    expect(arquivosDeBackup()).toHaveLength(2);
  });

  it('para de rodar depois que a função de parada é chamada', async () => {
    const logger = criarLoggerFalso();
    const parar = iniciarBackupPeriodico(db, pastaBackup, 60, logger);
    await new Promise((resolve) => setTimeout(resolve, 100));
    parar();
    const chamadasAntes = (logger.info as ReturnType<typeof vi.fn>).mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 100));
    const chamadasDepois = (logger.info as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(chamadasDepois).toBe(chamadasAntes);
  });
});
