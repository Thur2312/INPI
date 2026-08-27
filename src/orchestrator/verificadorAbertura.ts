import type { Logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

export interface VerificadorObjeto {
  objetoPeticaoDisponivel(
    textoBuscado: string,
    titularDocumento: string,
    numeroProcesso: string,
  ): Promise<{ encontrado: boolean; value: string | null; opcoesAtuais: readonly string[] }>;
}

export interface ControleOperacao {
  obterOperacao(): { status: string };
  liberarOperacao(objetoPeticaoValue: string): void;
}

/**
 * Um único verificador faz o polling do dropdown de objeto — não cada
 * worker. Quatro workers batendo no INPI em loop às 10h seria exatamente
 * o padrão de tráfego que a operação quer evitar. Workers ficam parados
 * em AGUARDANDO_ABERTURA (via `reivindicarProximo`, que já checa
 * `operacao.status`) até este verificador liberar a fila.
 *
 * Roda até encontrar o objeto ou o `sinal` de parada ser acionado
 * (permite encerrar limpo se a operação for cancelada antes da cota abrir).
 */
export async function verificarAbertura(
  verificador: VerificadorObjeto,
  controle: ControleOperacao,
  textoObjeto: string,
  /** CPF/CNPJ e número de processo de um requerimento real já na fila — necessários porque o INPI só popula os dropdowns de serviço/objeto depois de um cliente selecionado e um processo preenchido (ver `AdapterInpi.objetoPeticaoDisponivel`). */
  titularDocumento: string,
  numeroProcesso: string,
  opcoes: {
    logger: Logger;
    intervaloMinMs?: number;
    intervaloMaxMs?: number;
    sinal?: { parar: boolean };
  },
): Promise<void> {
  const { logger, intervaloMinMs = 20_000, intervaloMaxMs = 30_000, sinal } = opcoes;

  while (!sinal?.parar) {
    const operacao = controle.obterOperacao();
    if (operacao.status === 'RODANDO') {
      return; // já foi liberada por outro caminho (ex.: retomada manual)
    }

    try {
      const resultado = await verificador.objetoPeticaoDisponivel(
        textoObjeto,
        titularDocumento,
        numeroProcesso,
      );
      if (resultado.encontrado && resultado.value !== null) {
        controle.liberarOperacao(resultado.value);
        logger.info('cota liberada: objeto da petição encontrado no dropdown', {
          textoObjeto,
          value: resultado.value,
        });
        return;
      }
      logger.info('verificador de abertura: objeto ainda não disponível', {
        textoObjeto,
        opcoesAtuais: resultado.opcoesAtuais,
      });
    } catch (erro) {
      logger.warn('verificador de abertura: erro ao checar o dropdown, tentando de novo', {
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }

    const intervalo = intervaloMinMs + Math.random() * (intervaloMaxMs - intervaloMinMs);
    await sleep(intervalo);
  }
}
