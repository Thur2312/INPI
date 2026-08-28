import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextFunction, Response } from 'express';

/**
 * Serve o PDF de uma guia já emitida, resolvendo o caminho relativo salvo
 * no banco (`caminhoPdf`) contra a raiz do projeto. Compartilhado pelo
 * painel interno (`src/dashboard`, qualquer requerimento) e pelo portal
 * do cliente (`src/portalCliente`, só o requerimento do titular logado —
 * a checagem de dono acontece antes de chegar aqui, em quem chama).
 */
export function enviarPdf(
  caminhoPdf: string | null,
  raizProjeto: string,
  numeroProcesso: string,
  res: Response,
  next: NextFunction,
): void {
  if (!caminhoPdf) {
    res.status(404).json({ erro: 'esse requerimento ainda não tem boleto emitido' });
    return;
  }

  const caminhoAbsoluto = resolve(raizProjeto, caminhoPdf);
  if (!existsSync(caminhoAbsoluto)) {
    res.status(404).json({ erro: 'arquivo do boleto não foi encontrado no servidor' });
    return;
  }

  res.download(caminhoAbsoluto, `GRU-${numeroProcesso}.pdf`, (erro) => {
    if (erro) next(erro);
  });
}
