import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  buscarProcessoPorId,
  buscarProcessoPorIdETitular,
  listarProcessosPorTitularDocumento,
  listarTodosProcessos,
} from '../db/processos.js';
import { somenteDigitos, validarDocumento } from '../domain/validarDocumento.js';
import type { Processo } from '../domain/types.js';
import { criarMiddlewareBasicAuth } from '../utils/basicAuth.js';
import { enviarPdf } from '../utils/enviarPdf.js';
import { assinarToken, verificarToken } from './token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const VALIDADE_SESSAO_PADRAO_MS = 24 * 60 * 60 * 1000;

export interface CriarAppPortalOpcoes {
  /** Segredo para assinar/verificar o token de sessão do cliente — nunca vazio em produção. */
  segredoToken: string;
  /** Senha do Basic Auth da rota /api/admin/*; undefined desliga a checagem (só para dev/teste). */
  senhaAdmin?: string;
  /** Raiz do projeto, para resolver `caminhoPdf` (guardado relativo no banco) num caminho real de arquivo. */
  raizProjeto: string;
  validadeSessaoMs?: number;
}

const loginSchema = z.object({
  documento: z.string().trim().min(1, 'documento é obrigatório'),
});

interface RequisicaoComTitular extends Request {
  titularDocumento?: string;
}

/** Formato exposto ao cliente — nunca o `Processo` completo (some com `caminhoPdf` real, `worker`, etc.). */
function paraResumoCliente(p: Processo) {
  return {
    id: p.id,
    numeroProcesso: p.numeroProcesso,
    objetoPeticao: p.objetoPeticao,
    status: p.status,
    nossoNumero: p.nossoNumero,
    valorGru: p.valorGru,
    pdfDisponivel: p.caminhoPdf !== null,
    criadoEm: p.criadoEm,
    concluidoEm: p.concluidoEm,
  };
}

function autenticarCliente(segredoToken: string) {
  return (req: RequisicaoComTitular, res: Response, next: NextFunction): void => {
    const cabecalho = req.headers.authorization;
    if (!cabecalho?.startsWith('Bearer ')) {
      res.status(401).json({ erro: 'sessão necessária — faça login com o CNPJ/CPF' });
      return;
    }

    const resultado = verificarToken(cabecalho.slice('Bearer '.length), segredoToken);
    if (!resultado) {
      res.status(401).json({ erro: 'sessão inválida ou expirada — faça login novamente' });
      return;
    }

    req.titularDocumento = resultado.documento;
    next();
  };
}

/**
 * Backend do portal do cliente — superfície separada do painel operacional
 * (`src/dashboard`), pensada para o cliente final acompanhar e baixar os
 * boletos GRU dos próprios requerimentos, e para um admin acompanhar todos.
 *
 * Login do cliente é só o CNPJ/CPF (decisão de negócio: documento não é
 * segredo, mas é o suficiente para o caso de uso hoje — ver conversa em
 * 27/08/2026). O token de sessão emitido evita reenviar o documento em
 * toda requisição e faz a sessão expirar sozinha; não é substituto de
 * senha se o caso de uso pedir mais segurança no futuro.
 */
export function criarAppPortalCliente(db: Database.Database, opcoes: CriarAppPortalOpcoes): Express {
  const { segredoToken, senhaAdmin, raizProjeto, validadeSessaoMs = VALIDADE_SESSAO_PADRAO_MS } = opcoes;

  const app = express();
  app.use(express.json());

  app.post('/api/login', (req, res) => {
    const validacao = loginSchema.safeParse(req.body ?? {});
    if (!validacao.success) {
      res.status(400).json({ erro: validacao.error.issues.map((i) => i.message).join('; ') });
      return;
    }

    const documento = somenteDigitos(validacao.data.documento);
    const { valido } = validarDocumento(documento);
    if (!valido) {
      res.status(400).json({ erro: 'CNPJ/CPF inválido (dígito verificador não confere)' });
      return;
    }

    const processos = listarProcessosPorTitularDocumento(db, documento);
    if (processos.length === 0) {
      res.status(404).json({ erro: 'nenhum requerimento encontrado para esse CNPJ/CPF' });
      return;
    }

    const token = assinarToken(documento, segredoToken, validadeSessaoMs);
    res.json({ token, validadeMs: validadeSessaoMs });
  });

  app.get('/api/minhas-grus', autenticarCliente(segredoToken), (req: RequisicaoComTitular, res) => {
    const processos = listarProcessosPorTitularDocumento(db, req.titularDocumento as string);
    res.json({ processos: processos.map(paraResumoCliente) });
  });

  app.get('/api/grus/:id/pdf', autenticarCliente(segredoToken), (req: RequisicaoComTitular, res, next) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id)) {
      res.status(400).json({ erro: 'id inválido' });
      return;
    }

    const processo = buscarProcessoPorIdETitular(db, id, req.titularDocumento as string);
    if (!processo) {
      res.status(404).json({ erro: 'requerimento não encontrado' });
      return;
    }

    enviarPdf(processo.caminhoPdf, raizProjeto, processo.numeroProcesso, res, next);
  });

  const autenticarAdmin = criarMiddlewareBasicAuth(senhaAdmin, 'Portal Cliente - Admin');

  app.get('/api/admin/processos', autenticarAdmin, (_req, res) => {
    res.json({ processos: listarTodosProcessos(db) });
  });

  app.get('/api/admin/grus/:id/pdf', autenticarAdmin, (req, res, next) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id)) {
      res.status(400).json({ erro: 'id inválido' });
      return;
    }

    const processo = buscarProcessoPorId(db, id);
    if (!processo) {
      res.status(404).json({ erro: 'requerimento não encontrado' });
      return;
    }

    enviarPdf(processo.caminhoPdf, raizProjeto, processo.numeroProcesso, res, next);
  });

  app.use(express.static(join(__dirname, 'public')));

  return app;
}
