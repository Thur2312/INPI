import { CODIGO_SERVICO_3020 } from '../config/constants.js';
import type { GruEncontrada } from './adapter.js';

/**
 * Só depende do método que de fato usa, não da classe `AdapterInpi`
 * inteira — permite testar a lógica de classificação com um objeto falso
 * comum, sem precisar de um navegador de verdade.
 */
export interface ConsultaGrus {
  consultarGrusDoCliente(documento: string, inicio: Date, fim: Date): Promise<GruEncontrada[]>;
}

export type StatusReconciliacao = 'NENHUMA_ENCONTRADA' | 'ENCONTRADA_UNICA' | 'AMBIGUA';

export interface ResultadoReconciliacao {
  status: StatusReconciliacao;
  /**
   * Guias 3020 encontradas para o titular na janela pesquisada. Nunca é
   * usado para casar automaticamente com um processo — quando há mais de
   * uma, a decisão de qual (se alguma) corresponde é humana. Mesma
   * filosofia da exigência de linha única na busca de cliente.
   */
  candidatas: GruEncontrada[];
}

/**
 * Responde "essa guia já saiu ou não?" para um processo em estado
 * incerto (órfão em GRU_EM_PROCESSAMENTO, falha após o clique em "Gerar
 * boleto", recuperação de banco corrompido). Filtra por serviço 3020;
 * como a listagem é por titular, um titular com várias marcas pode ter
 * mais de uma guia 3020 no mesmo dia — por isso retorna a lista, nunca
 * decide sozinha.
 */
export async function reconciliarProcesso(
  consulta: ConsultaGrus,
  processo: { titularDocumento: string; dataOperacao: Date },
): Promise<ResultadoReconciliacao> {
  const encontradas = await consulta.consultarGrusDoCliente(
    processo.titularDocumento,
    processo.dataOperacao,
    processo.dataOperacao,
  );

  const candidatas = encontradas.filter((g) => g.servico.includes(CODIGO_SERVICO_3020));

  if (candidatas.length === 0) {
    return { status: 'NENHUMA_ENCONTRADA', candidatas: [] };
  }
  if (candidatas.length === 1) {
    return { status: 'ENCONTRADA_UNICA', candidatas };
  }
  return { status: 'AMBIGUA', candidatas };
}
