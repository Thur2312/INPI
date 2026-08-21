import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { listarTodosProcessos } from '../db/processos.js';
import type { Processo } from '../domain/types.js';

interface LinhaRelatorio {
  posicao: number;
  fila: string;
  cliente: string;
  titularDocumento: string;
  titularNome: string;
  numeroProcesso: string;
  objetoPeticao: string;
  status: string;
  tentativas: number;
  nossoNumero: string;
  codigoGru: string;
  valorGru: string;
  caminhoPdf: string;
  erroTipo: string;
  erroMensagem: string;
  iniciadoEm: string;
  concluidoEm: string;
}

const COLUNAS: { chave: keyof LinhaRelatorio; titulo: string; largura: number }[] = [
  { chave: 'posicao', titulo: 'Posição', largura: 10 },
  { chave: 'fila', titulo: 'Fila', largura: 12 },
  { chave: 'cliente', titulo: 'Cliente', largura: 20 },
  { chave: 'titularDocumento', titulo: 'Documento do Titular', largura: 20 },
  { chave: 'titularNome', titulo: 'Nome do Titular', largura: 30 },
  { chave: 'numeroProcesso', titulo: 'Número do Processo', largura: 18 },
  { chave: 'objetoPeticao', titulo: 'Objeto da Petição', largura: 18 },
  { chave: 'status', titulo: 'Status', largura: 26 },
  { chave: 'tentativas', titulo: 'Tentativas', largura: 10 },
  { chave: 'nossoNumero', titulo: 'Nosso Número', largura: 20 },
  { chave: 'codigoGru', titulo: 'Código GRU', largura: 16 },
  { chave: 'valorGru', titulo: 'Valor GRU', largura: 12 },
  { chave: 'caminhoPdf', titulo: 'Caminho do PDF', largura: 40 },
  { chave: 'erroTipo', titulo: 'Tipo do Erro', largura: 24 },
  { chave: 'erroMensagem', titulo: 'Mensagem do Erro', largura: 40 },
  { chave: 'iniciadoEm', titulo: 'Iniciado em', largura: 22 },
  { chave: 'concluidoEm', titulo: 'Concluído em', largura: 22 },
];

function paraLinha(p: Processo): LinhaRelatorio {
  return {
    posicao: p.posicao,
    fila: p.fila,
    cliente: p.cliente ?? '',
    titularDocumento: p.titularDocumento,
    titularNome: p.titularNome ?? '',
    numeroProcesso: p.numeroProcesso,
    objetoPeticao: p.objetoPeticao,
    status: p.status,
    tentativas: p.tentativas,
    nossoNumero: p.nossoNumero ?? '',
    codigoGru: p.codigoGru ?? '',
    valorGru: p.valorGru ?? '',
    caminhoPdf: p.caminhoPdf ?? '',
    erroTipo: p.erroTipo ?? '',
    erroMensagem: p.erroMensagem ?? '',
    iniciadoEm: p.iniciadoEm ?? '',
    concluidoEm: p.concluidoEm ?? '',
  };
}

function gerarLinhasRelatorio(db: Database.Database): LinhaRelatorio[] {
  return listarTodosProcessos(db).map(paraLinha);
}

function escaparCsv(valor: string): string {
  if (/[",\r\n]/.test(valor)) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

/**
 * Gera o CSV em memória (sem tocar disco) — usado tanto pelo relatório
 * final quanto pelo download sob demanda do dashboard. BOM UTF-8 no início
 * porque o Excel, sem ele, interpreta acentos como Latin-1 e corrompe o
 * texto.
 */
export function gerarCsvString(db: Database.Database): string {
  const linhas = gerarLinhasRelatorio(db);
  const cabecalho = COLUNAS.map((c) => c.titulo).join(',');
  const corpo = linhas
    .map((linha) => COLUNAS.map((c) => escaparCsv(String(linha[c.chave]))).join(','))
    .join('\r\n');
  const bomUtf8 = '\uFEFF';
  return `${bomUtf8}${cabecalho}\r\n${corpo}${corpo ? '\r\n' : ''}`;
}

/** Gera o workbook XLSX em memória — mesma lógica de linhas do CSV. */
// eslint-disable-next-line @typescript-eslint/require-await -- assinatura async por simetria com gerarRelatorioXlsx (que de fato await), mantém a API do módulo consistente
export async function gerarWorkbook(db: Database.Database): Promise<ExcelJS.Workbook> {
  const linhas = gerarLinhasRelatorio(db);
  const workbook = new ExcelJS.Workbook();
  const planilha = workbook.addWorksheet('GRUs 3020');
  planilha.columns = COLUNAS.map((c) => ({ header: c.titulo, key: c.chave, width: c.largura }));
  planilha.addRows(linhas);
  planilha.getRow(1).font = { bold: true };
  planilha.views = [{ state: 'frozen', ySplit: 1 }];
  return workbook;
}

export function gerarRelatorioCsv(db: Database.Database, caminho: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, gerarCsvString(db), 'utf-8');
}

export async function gerarRelatorioXlsx(db: Database.Database, caminho: string): Promise<void> {
  const workbook = await gerarWorkbook(db);
  mkdirSync(dirname(caminho), { recursive: true });
  await workbook.xlsx.writeFile(caminho);
}

export interface ResultadoRelatorios {
  csv: string;
  xlsx: string;
}

/**
 * Gera o par CSV + XLSX do estado atual da fila, com nome de arquivo
 * carimbado (permite rodar mais de uma vez no dia sem sobrescrever o
 * anterior — útil se a operação for retomada depois de uma pausa).
 */
export async function gerarRelatorios(
  db: Database.Database,
  pastaSaida: string,
): Promise<ResultadoRelatorios> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csv = join(pastaSaida, `relatorio-${timestamp}.csv`);
  const xlsx = join(pastaSaida, `relatorio-${timestamp}.xlsx`);
  gerarRelatorioCsv(db, csv);
  await gerarRelatorioXlsx(db, xlsx);
  return { csv, xlsx };
}
