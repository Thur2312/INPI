import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import { linhaPlanilhaSchema, type LinhaPlanilha } from './schema.js';

export interface LinhaImportada {
  /** Ordem de aparição na planilha (1-based, contando só linhas de dado) — vira `posicao` no banco. */
  posicao: number;
  dados: LinhaPlanilha;
}

export interface ErroImportacao {
  posicao: number;
  mensagem: string;
}

export interface ResultadoImportacao {
  linhas: LinhaImportada[];
  erros: ErroImportacao[];
}

/**
 * Lê CSV ou XLSX e valida cada linha contra `linhaPlanilhaSchema`. Não
 * lança no primeiro erro: linhas inválidas são coletadas em `erros` (com o
 * número da linha) para o operador corrigir a planilha de uma vez, em vez
 * de ficar corrigindo e reimportando erro por erro.
 */
export async function importarPlanilha(caminho: string): Promise<ResultadoImportacao> {
  const workbook = new ExcelJS.Workbook();
  const ext = extname(caminho).toLowerCase();

  if (ext === '.csv') {
    await workbook.csv.readFile(caminho);
  } else {
    await workbook.xlsx.readFile(caminho);
  }

  if (workbook.worksheets.length === 0) {
    throw new Error(`Planilha "${caminho}" não contém nenhuma aba.`);
  }

  const worksheet = encontrarWorksheetDeDados(workbook);
  const cabecalho = lerCabecalho(worksheet);

  const linhas: LinhaImportada[] = [];
  const erros: ErroImportacao[] = [];
  let posicao = 0;

  for (let numeroLinha = 2; numeroLinha <= worksheet.rowCount; numeroLinha += 1) {
    const row = worksheet.getRow(numeroLinha);
    if (row.cellCount === 0) continue; // linha em branco no meio da planilha

    const bruta: Record<string, unknown> = {};
    cabecalho.forEach((nomeColuna, indice) => {
      if (!nomeColuna) return;
      const cell = row.getCell(indice + 1);
      bruta[nomeColuna] = celulaParaValor(cell.value);
    });

    posicao += 1;
    const resultado = linhaPlanilhaSchema.safeParse(bruta);
    if (resultado.success) {
      linhas.push({ posicao, dados: resultado.data });
    } else {
      const mensagem = resultado.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      erros.push({ posicao, mensagem });
    }
  }

  return { linhas, erros };
}

/**
 * Colunas cuja presença no cabeçalho identifica a aba de dados de verdade
 * — ver `linhaPlanilhaSchema`. Não bastava pegar sempre `worksheets[0]`:
 * o modelo distribuído pro cliente (ver `docs/`) tem uma aba de
 * "Instruções" antes da aba com os dados, e o nome dessa 2ª aba não é
 * garantido (ex.: "Processos"), então a checagem é pelo cabeçalho, não
 * pelo nome. Cai para `worksheets[0]` se nenhuma aba bater — mantém
 * compatível com planilhas de uma aba só (CSV é sempre isso) e com
 * arquivos que, por engano, não têm nenhuma coluna reconhecida (o erro
 * de "campo obrigatório ausente" por linha já cobre esse caso depois).
 */
function encontrarWorksheetDeDados(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const COLUNAS_IDENTIFICADORAS = ['titular_documento', 'numero_processo', 'objeto_peticao'];

  for (const worksheet of workbook.worksheets) {
    const cabecalho = lerCabecalho(worksheet);
    if (COLUNAS_IDENTIFICADORAS.every((coluna) => cabecalho.includes(coluna))) {
      return worksheet;
    }
  }

  return workbook.worksheets[0]!;
}

function lerCabecalho(worksheet: ExcelJS.Worksheet): string[] {
  const cabecalho: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumero) => {
    cabecalho[colNumero - 1] = valorParaTexto(celulaParaValor(cell.value)).trim();
  });
  return cabecalho;
}

function celulaParaValor(valor: ExcelJS.CellValue): unknown {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'object') {
    if ('text' in valor) return valor.text; // rich text
    if ('result' in valor) return valor.result; // fórmula
  }
  return valor;
}

function valorParaTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  if (valor instanceof Date) return valor.toISOString();
  return '';
}
