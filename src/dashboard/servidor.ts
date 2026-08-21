import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import express, { type Express } from 'express';
import { obterOperacao, retomarOperacao } from '../db/operacao.js';
import { contarPorStatus, listarTodosProcessos } from '../db/processos.js';
import { gerarCsvString, gerarWorkbook } from '../reports/relatorio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Monta o app Express do dashboard. Fica deliberadamente só-leitura, com
 * uma única exceção mutável: `/api/retomar`, que existe porque
 * `ERRO_OBJETO_INDISPONIVEL` pausa a operação inteira (ver `operacao.ts`) e
 * sem esse botão a única forma de destravar seria mexer direto no SQLite.
 * Nenhuma outra rota altera o banco.
 */
export function criarApp(db: Database.Database): Express {
  const app = express();

  app.get('/api/status', (_req, res) => {
    res.json({
      operacao: obterOperacao(db),
      contagens: contarPorStatus(db),
      processos: listarTodosProcessos(db),
    });
  });

  app.post('/api/retomar', (_req, res) => {
    const operacao = obterOperacao(db);
    if (operacao.status !== 'PAUSADA') {
      res.status(409).json({ erro: 'a operação não está pausada', statusAtual: operacao.status });
      return;
    }
    retomarOperacao(db);
    res.json(obterOperacao(db));
  });

  app.get('/api/relatorio.csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorio-gru-3020.csv"');
    res.send(gerarCsvString(db));
  });

  app.get('/api/relatorio.xlsx', (_req, res, next) => {
    gerarWorkbook(db)
      .then((workbook) => workbook.xlsx.writeBuffer())
      .then((buffer) => {
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader('Content-Disposition', 'attachment; filename="relatorio-gru-3020.xlsx"');
        res.send(Buffer.from(buffer));
      })
      .catch(next);
  });

  app.use(express.static(join(__dirname, 'public')));

  return app;
}
