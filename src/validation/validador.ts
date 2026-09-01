import { aplicarTetoPorTitular, type CandidatoProcesso } from '../domain/regrasNegocio.js';
import type { Fila } from '../domain/types.js';
import { somenteDigitos, validarDocumento } from '../domain/validarDocumento.js';
import { validarNumeroProcesso } from '../domain/validarNumeroProcesso.js';
import type { LinhaImportada } from './importarPlanilha.js';

export type StatusValidacao = 'VALIDADO' | 'PENDENCIA_DADOS' | 'PENDENCIA_LIMITE';

export interface LinhaProcessada {
  posicao: number;
  fila: Fila;
  cliente: string | null;
  titularDocumento: string;
  titularNome: string | null;
  numeroProcesso: string;
  objetoPeticao: string;
  prioridade: number | null;
  protocolosJaUtilizados: number;
  status: StatusValidacao;
  erroMensagem: string | null;
}

/**
 * Orquestra a validação completa de uma planilha já importada:
 * 1. valida dígito verificador de CPF/CNPJ e formato do número de processo;
 * 2. quando o mesmo numero_processo aparece mais de uma vez no lote, mantém
 *    a 1ª ocorrência (ordem de aparição na planilha) como candidata normal e
 *    rejeita só as repetições seguintes — a alternativa (rejeitar todas as
 *    ocorrências) já causou um processo de cliente sumir da fila sem
 *    ninguém notar, porque nenhuma das cópias chegava a virar erro isolado
 *    o bastante pra ser óbvio no relatório;
 * 3. rejeita também contra `numerosProcessoExistentes` (processos já
 *    gravados no banco por uma importação anterior; ver
 *    `importarPlanilhaParaBanco`);
 * 4. aplica o teto de 10 requerimentos por titular sobre o que sobrou.
 *
 * Cada linha sai com um status final e, se não for VALIDADO, um motivo
 * legível — é o que alimenta o relatório de pendências.
 */
export function validarLinhas(
  linhas: LinhaImportada[],
  numerosProcessoExistentes: ReadonlySet<string> = new Set(),
): LinhaProcessada[] {
  const pendentes: LinhaProcessada[] = [];
  const candidatos: (CandidatoProcesso & { titularDocumentoOriginal: string })[] = [];

  const posicaoDaPrimeiraOcorrencia = new Map<string, number>();
  for (const linha of linhas) {
    const { normalizado } = validarNumeroProcesso(linha.dados.numero_processo);
    if (!posicaoDaPrimeiraOcorrencia.has(normalizado)) {
      posicaoDaPrimeiraOcorrencia.set(normalizado, linha.posicao);
    }
  }

  for (const linha of linhas) {
    const { dados, posicao } = linha;
    const docResultado = validarDocumento(dados.titular_documento);
    const numeroResultado = validarNumeroProcesso(dados.numero_processo);
    const primeiraOcorrencia = posicaoDaPrimeiraOcorrencia.get(numeroResultado.normalizado);
    const numeroDuplicado = primeiraOcorrencia !== undefined && primeiraOcorrencia !== posicao;
    const numeroJaNoBanco = numerosProcessoExistentes.has(numeroResultado.normalizado);

    const problemas: string[] = [];
    if (!docResultado.valido) {
      problemas.push(
        `titular_documento "${dados.titular_documento}" tem dígito verificador inválido`,
      );
    }
    if (!numeroResultado.valido) {
      problemas.push(`numero_processo "${dados.numero_processo}" fora do formato esperado`);
    }
    if (numeroDuplicado) {
      problemas.push(
        `numero_processo "${numeroResultado.normalizado}" duplicado na planilha — mantida a 1ª ocorrência (linha ${primeiraOcorrencia})`,
      );
    }
    if (numeroJaNoBanco) {
      problemas.push(
        `numero_processo "${numeroResultado.normalizado}" já existe no banco (importação anterior?) — não reimportado, evita gerar uma segunda GRU para o mesmo processo`,
      );
    }

    if (problemas.length > 0) {
      pendentes.push({
        posicao,
        fila: dados.fila,
        cliente: dados.cliente ?? null,
        titularDocumento: somenteDigitos(dados.titular_documento),
        titularNome: dados.titular_nome ?? null,
        numeroProcesso: numeroResultado.normalizado,
        objetoPeticao: dados.objeto_peticao,
        prioridade: dados.prioridade ?? null,
        protocolosJaUtilizados: dados.protocolos_ja_utilizados,
        status: 'PENDENCIA_DADOS',
        erroMensagem: problemas.join('; '),
      });
      continue;
    }

    candidatos.push({
      posicao,
      fila: dados.fila,
      cliente: dados.cliente ?? null,
      titularDocumento: somenteDigitos(dados.titular_documento),
      titularDocumentoOriginal: dados.titular_documento,
      titularNome: dados.titular_nome ?? null,
      numeroProcesso: numeroResultado.normalizado,
      objetoPeticao: dados.objeto_peticao,
      prioridade: dados.prioridade ?? null,
      protocolosJaUtilizados: dados.protocolos_ja_utilizados,
    });
  }

  const comTeto = aplicarTetoPorTitular(candidatos);

  const processadas: LinhaProcessada[] = comTeto.map((c) => ({
    posicao: c.posicao,
    fila: c.fila,
    cliente: c.cliente,
    titularDocumento: c.titularDocumento,
    titularNome: c.titularNome,
    numeroProcesso: c.numeroProcesso,
    objetoPeticao: c.objetoPeticao,
    prioridade: c.prioridade,
    protocolosJaUtilizados: c.protocolosJaUtilizados,
    status: c.elegivel ? 'VALIDADO' : 'PENDENCIA_LIMITE',
    erroMensagem: c.motivoPendencia,
  }));

  return [...pendentes, ...processadas].sort((a, b) => a.posicao - b.posicao);
}
