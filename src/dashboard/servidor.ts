import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { limparAlertaCategoria, obterOperacao, retomarOperacao } from '../db/operacao.js';
import {
  buscarProcessoPorId,
  contarPorStatus,
  existemProcessosPendentes,
  listarTodosProcessos,
} from '../db/processos.js';
import { gerarCsvString, gerarWorkbook } from '../reports/relatorio.js';
import { comparacaoSegura } from '../utils/basicAuth.js';
import { enviarPdf } from '../utils/enviarPdf.js';
import type { Logger } from '../utils/logger.js';
import { assinarToken, verificarToken } from '../utils/token.js';
import { importarPlanilhaParaBanco } from '../validation/importarParaBanco.js';
import type { GerenciadorOperacao } from './gerenciadorOperacao.js';

const NOME_COOKIE_SESSAO = 'sessao';
const VALIDADE_SESSAO_MS = 12 * 60 * 60 * 1000; // 12h — reautentica no dia seguinte, não precisa lembrar de sair.
/** Assunto fixo do token — não há usuários individuais aqui, só a senha compartilhada do painel. */
const ASSUNTO_SESSAO_DASHBOARD = 'dashboard';

function lerCookie(req: Request, nome: string): string | null {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    if (parte.slice(0, igual).trim() === nome) {
      return decodeURIComponent(parte.slice(igual + 1).trim());
    }
  }
  return null;
}

function definirCookieSessao(req: Request, res: Response, token: string): void {
  const seguro = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  const validadeSegundos = Math.floor(VALIDADE_SESSAO_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${NOME_COOKIE_SESSAO}=${token}; HttpOnly; SameSite=Lax; Max-Age=${validadeSegundos}; Path=/${seguro ? '; Secure' : ''}`,
  );
}

function limparCookieSessao(res: Response): void {
  res.setHeader('Set-Cookie', `${NOME_COOKIE_SESSAO}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
}

/**
 * Substitui o popup nativo de HTTP Basic Auth (feio, sem como estilizar)
 * por uma sessão de verdade: `POST /api/login` verifica a senha e emite um
 * cookie assinado (HMAC, sem estado no servidor — mesmo mecanismo do
 * portal do cliente, ver `src/utils/token.ts`), esta função só confere
 * esse cookie. Registrada como gate de tudo em `/api/*` exceto o próprio
 * login — a ordem de registro das rotas em `criarApp` garante isso (ver
 * comentário lá).
 */
function exigirSessao(senha: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!senha) {
      next();
      return;
    }

    const token = lerCookie(req, NOME_COOKIE_SESSAO);
    const resultado = token ? verificarToken(token, senha) : null;
    if (!resultado) {
      res.status(401).json({ erro: 'sessão necessária — faça login' });
      return;
    }
    next();
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ConfigOperacaoPadrao {
  maxWorkers: number;
  pausaEntreAcoesMinMs: number;
  pausaEntreAcoesMaxMs: number;
  largadaWorkerMinMs: number;
  largadaWorkerMaxMs: number;
  verificadorIntervaloMinMs: number;
  verificadorIntervaloMaxMs: number;
}

export interface CriarAppOpcoes {
  gerenciadorOperacao: GerenciadorOperacao;
  configPadrao: ConfigOperacaoPadrao;
  logPath: string;
  logger: Logger;
  /**
   * Senha compartilhada do painel — vira uma sessão por cookie assinado
   * (ver `POST /api/login`/`exigirSessao`), não HTTP Basic Auth (era assim
   * antes; trocado por ter uma tela de login com a identidade visual, o
   * popup nativo do navegador não dava pra estilizar). Se `undefined`, o
   * painel fica sem autenticação própria — aceitável só quando está atrás
   * de uma rede fechada (Tailscale, ver `docs/runbook-vps.md`). Agora que
   * o painel pode subir a automação e receber planilhas com CPF/CNPJ de
   * cliente, configurar isso em produção deixou de ser opcional de fato,
   * só continua opcional no código para não quebrar os testes.
   */
  senha?: string;
  /** Raiz do projeto, para resolver `caminhoPdf` (guardado relativo no banco) num caminho real de arquivo. */
  raizProjeto: string;
}

const loginSchema = z.object({
  senha: z.string().default(''),
});

const overridesOperacaoSchema = z
  .object({
    maxWorkers: z.coerce.number().int().min(1).max(20).optional(),
    pausaEntreAcoesMinMs: z.coerce.number().int().min(0).optional(),
    pausaEntreAcoesMaxMs: z.coerce.number().int().min(0).optional(),
    largadaWorkerMinMs: z.coerce.number().int().min(0).optional(),
    largadaWorkerMaxMs: z.coerce.number().int().min(0).optional(),
    verificadorIntervaloMinMs: z.coerce.number().int().min(0).optional(),
    verificadorIntervaloMaxMs: z.coerce.number().int().min(0).optional(),
  })
  .refine(
    (v) =>
      v.pausaEntreAcoesMinMs === undefined ||
      v.pausaEntreAcoesMaxMs === undefined ||
      v.pausaEntreAcoesMinMs <= v.pausaEntreAcoesMaxMs,
    { message: 'pausaEntreAcoesMinMs não pode ser maior que pausaEntreAcoesMaxMs' },
  )
  .refine(
    (v) =>
      v.largadaWorkerMinMs === undefined ||
      v.largadaWorkerMaxMs === undefined ||
      v.largadaWorkerMinMs <= v.largadaWorkerMaxMs,
    { message: 'largadaWorkerMinMs não pode ser maior que largadaWorkerMaxMs' },
  )
  .refine(
    (v) =>
      v.verificadorIntervaloMinMs === undefined ||
      v.verificadorIntervaloMaxMs === undefined ||
      v.verificadorIntervaloMinMs <= v.verificadorIntervaloMaxMs,
    { message: 'verificadorIntervaloMinMs não pode ser maior que verificadorIntervaloMaxMs' },
  );

/** Nomes das variáveis de ambiente lidas por `src/config/env.ts` — mesma fonte de verdade dos nomes usados lá. */
const MAPA_ENV: Record<keyof z.infer<typeof overridesOperacaoSchema>, string> = {
  maxWorkers: 'MAX_WORKERS',
  pausaEntreAcoesMinMs: 'PAUSA_ENTRE_ACOES_MIN_MS',
  pausaEntreAcoesMaxMs: 'PAUSA_ENTRE_ACOES_MAX_MS',
  largadaWorkerMinMs: 'LARGADA_WORKER_MIN_MS',
  largadaWorkerMaxMs: 'LARGADA_WORKER_MAX_MS',
  verificadorIntervaloMinMs: 'VERIFICADOR_INTERVALO_MIN_MS',
  verificadorIntervaloMaxMs: 'VERIFICADOR_INTERVALO_MAX_MS',
};

function paraOverridesEnv(overrides: z.infer<typeof overridesOperacaoSchema>): Record<string, string> {
  const resultado: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(overrides)) {
    if (valor === undefined) continue;
    const nomeEnv = MAPA_ENV[chave as keyof typeof MAPA_ENV];
    resultado[nomeEnv] = String(valor);
  }
  return resultado;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Monta o app Express do dashboard — agora superfície de controle
 * completa, não só monitoramento: importa planilha, inicia/para a
 * operação real (`npm run operar`, via `gerenciadorOperacao`) e ajusta o
 * ritmo dela por formulário, sem precisar de terminal/SSH depois do
 * deploy inicial.
 */
export function criarApp(db: Database.Database, opcoes: CriarAppOpcoes): Express {
  const app = express();

  // Login/logout ficam registrados ANTES do gate de sessão — em Express,
  // uma rota que já responde (não chama `next()`) nunca chega no
  // middleware seguinte, então `/api/login` nunca passa por
  // `exigirSessao` mesmo sem estar numa lista de exceções explícita.
  app.post('/api/login', express.json(), (req, res) => {
    if (!opcoes.senha) {
      res.json({ ok: true });
      return;
    }

    const validacao = loginSchema.safeParse(req.body ?? {});
    const senhaRecebida = validacao.success ? validacao.data.senha : '';
    if (!comparacaoSegura(senhaRecebida, opcoes.senha)) {
      res.status(401).json({ erro: 'senha incorreta' });
      return;
    }

    const token = assinarToken(ASSUNTO_SESSAO_DASHBOARD, opcoes.senha, VALIDADE_SESSAO_MS);
    definirCookieSessao(req, res, token);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    limparCookieSessao(res);
    res.json({ ok: true });
  });

  app.use('/api', exigirSessao(opcoes.senha));

  app.get('/api/status', (_req, res) => {
    res.json({
      operacao: obterOperacao(db),
      contagens: contarPorStatus(db),
      processos: listarTodosProcessos(db),
      processoOperacao: opcoes.gerenciadorOperacao.estado(),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json(opcoes.configPadrao);
  });

  app.get('/api/processos/:id/pdf', (req, res, next) => {
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

    enviarPdf(processo.caminhoPdf, opcoes.raizProjeto, processo.numeroProcesso, res, next);
  });

  app.get('/api/log', (_req, res) => {
    let linhas: string[] = [];
    try {
      const conteudo = readFileSync(opcoes.logPath, 'utf-8');
      linhas = conteudo.split('\n').filter(Boolean);
    } catch {
      linhas = [];
    }
    res.json({ linhas: linhas.slice(-300) });
  });

  app.post('/api/alerta-categoria/descartar', (_req, res) => {
    limparAlertaCategoria(db);
    res.json(obterOperacao(db));
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

  app.post('/api/importar', upload.single('planilha'), (req, res, next) => {
    void (async () => {
      if (!req.file) {
        res.status(400).json({ erro: 'nenhum arquivo enviado (campo "planilha")' });
        return;
      }
      const ext = extname(req.file.originalname).toLowerCase();
      if (ext !== '.csv' && ext !== '.xlsx') {
        res
          .status(400)
          .json({ erro: `extensão não suportada: "${ext}" — envie .csv ou .xlsx` });
        return;
      }

      const caminhoTemp = join(tmpdir(), `inpi-importar-${Date.now()}-${randomUUID()}${ext}`);
      try {
        await writeFile(caminhoTemp, req.file.buffer);
        const resumo = await importarPlanilhaParaBanco(db, caminhoTemp, opcoes.logger);
        res.json(resumo);
      } catch (erro) {
        next(erro);
      } finally {
        await unlink(caminhoTemp).catch(() => {});
      }
    })();
  });

  app.post('/api/iniciar', express.json(), (req, res) => {
    const validacao = overridesOperacaoSchema.safeParse(req.body ?? {});
    if (!validacao.success) {
      res.status(400).json({ erro: validacao.error.issues.map((i) => i.message).join('; ') });
      return;
    }

    // Sem isso, "Iniciar operação" sobe a automação de qualquer jeito e ela
    // fica com a fila vazia sem avisar nada — o operador só percebe olhando
    // o log. Bloquear aqui é a mesma checagem que `existemProcessosPendentes`
    // já faz pro worker saber quando a fila esgotou de verdade (Etapa 3),
    // reaproveitada como pré-condição pra nem deixar começar.
    if (!existemProcessosPendentes(db)) {
      res.status(409).json({
        erro:
          'nenhuma planilha válida importada ainda — importe uma planilha (passo 1) antes de iniciar a operação',
      });
      return;
    }

    try {
      const estado = opcoes.gerenciadorOperacao.iniciar(paraOverridesEnv(validacao.data));
      res.json(estado);
    } catch (erro) {
      res.status(409).json({ erro: erro instanceof Error ? erro.message : String(erro) });
    }
  });

  app.post('/api/parar', (_req, res) => {
    opcoes.gerenciadorOperacao.parar();
    res.json({ parando: true });
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
