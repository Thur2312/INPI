const INTERVALO_POLLING_MS = 3000;
const INTERVALO_LOG_MS = 4000;

const elBadge = document.getElementById('status-badge');
const elBadgeProcesso = document.getElementById('status-processo');
const elMotivo = document.getElementById('status-motivo');
const elBtnRetomar = document.getElementById('btn-retomar');
const elAlertaCategoria = document.getElementById('alerta-categoria');
const elAlertaCategoriaTexto = document.getElementById('alerta-categoria-texto');
const elBtnDescartarAlerta = document.getElementById('btn-descartar-alerta');
const elMetricas = document.getElementById('metricas');
const elFiltroTexto = document.getElementById('filtro-texto');
const elFiltroStatus = document.getElementById('filtro-status');
const elCorpoTabela = document.getElementById('corpo-tabela');
const elUltimaAtualizacao = document.getElementById('ultima-atualizacao');

const elFormImportar = document.getElementById('form-importar');
const elCampoPlanilha = document.getElementById('campo-planilha');
const elBtnImportar = document.getElementById('btn-importar');
const elResultadoImportar = document.getElementById('resultado-importar');

const elFormIniciar = document.getElementById('form-iniciar');
const elCampoMaxWorkers = document.getElementById('campo-max-workers');
const elCampoPausaMin = document.getElementById('campo-pausa-min');
const elCampoPausaMax = document.getElementById('campo-pausa-max');
const elCampoLargadaMin = document.getElementById('campo-largada-min');
const elCampoLargadaMax = document.getElementById('campo-largada-max');
const elCampoVerificadorMin = document.getElementById('campo-verificador-min');
const elCampoVerificadorMax = document.getElementById('campo-verificador-max');
const elBtnIniciar = document.getElementById('btn-iniciar');
const elBtnParar = document.getElementById('btn-parar');
const elResultadoIniciar = document.getElementById('resultado-iniciar');

const elLogOperacao = document.getElementById('log-operacao');

let ultimoStatusPayload = null;
let processoRodando = false;

function classeBadgeOperacao(status) {
  if (status === 'RODANDO') return 'badge--rodando';
  if (status === 'PAUSADA') return 'badge--pausada';
  if (status === 'AGUARDANDO_ABERTURA') return 'badge--aguardando';
  return 'badge--neutro';
}

function classePilulaStatus(status) {
  if (status === 'GRU_EMITIDA') return 'pilula-status--sucesso';
  if (status.startsWith('ERRO_') || status === 'EMISSAO_INCERTA') return 'pilula-status--erro';
  if (status.startsWith('PENDENCIA_')) return 'pilula-status--alerta';
  return 'pilula-status--neutro';
}

function formatarStatus(status) {
  return status.replaceAll('_', ' ');
}

function renderizarOperacao(operacao) {
  elBadge.textContent = operacao.status.replaceAll('_', ' ');
  elBadge.className = `badge ${classeBadgeOperacao(operacao.status)}`;
  elMotivo.textContent = operacao.motivo ?? '';
  elBtnRetomar.classList.toggle('oculto', operacao.status !== 'PAUSADA');
}

function renderizarAlertaCategoria(operacao) {
  const opcoes = operacao.alertaCategoriaOpcoes;
  if (!opcoes || opcoes.length === 0) {
    elAlertaCategoria.classList.add('oculto');
    return;
  }
  elAlertaCategoria.classList.remove('oculto');
  elAlertaCategoriaTexto.textContent =
    `Apareceu no dropdown de objeto da petição: "${opcoes.join('", "')}" — ` +
    'nenhuma bate com o texto configurado. Confira se é a categoria certa antes de ajustar a configuração.';
}

function renderizarProcessoOperacao(processoOperacao) {
  processoRodando = processoOperacao.rodando;
  if (processoOperacao.rodando) {
    elBadgeProcesso.textContent = `processo: rodando (pid ${processoOperacao.pid})`;
    elBadgeProcesso.className = 'badge badge--processo-rodando';
  } else {
    elBadgeProcesso.textContent = 'processo: parado';
    elBadgeProcesso.className = 'badge badge--processo-parado';
  }
  elBtnIniciar.disabled = processoOperacao.rodando;
  elBtnParar.classList.toggle('oculto', !processoOperacao.rodando);
  for (const campo of [
    elCampoMaxWorkers,
    elCampoPausaMin,
    elCampoPausaMax,
    elCampoLargadaMin,
    elCampoLargadaMax,
    elCampoVerificadorMin,
    elCampoVerificadorMax,
  ]) {
    campo.disabled = processoOperacao.rodando;
  }
}

function renderizarMetricas(contagens, total) {
  const entradas = Object.entries(contagens).sort((a, b) => b[1] - a[1]);
  const blocos = [
    `<div class="metrica"><span class="metrica-valor">${total}</span><span class="metrica-rotulo">Total</span></div>`,
    ...entradas.map(
      ([status, qtd]) =>
        `<div class="metrica"><span class="metrica-valor">${qtd}</span><span class="metrica-rotulo">${formatarStatus(status)}</span></div>`,
    ),
  ];
  elMetricas.innerHTML = blocos.join('');
}

function atualizarOpcoesFiltro(contagens) {
  const statusAtuais = new Set(Object.keys(contagens));
  const valorSelecionado = elFiltroStatus.value;
  const existentes = new Set(
    Array.from(elFiltroStatus.options)
      .slice(1)
      .map((o) => o.value),
  );

  if (
    statusAtuais.size === existentes.size &&
    [...statusAtuais].every((s) => existentes.has(s))
  ) {
    return;
  }

  const ordenado = [...statusAtuais].sort();
  elFiltroStatus.innerHTML =
    '<option value="">Todos os status</option>' +
    ordenado.map((s) => `<option value="${s}">${formatarStatus(s)}</option>`).join('');
  elFiltroStatus.value = statusAtuais.has(valorSelecionado) ? valorSelecionado : '';
}

function escaparHtml(valor) {
  const div = document.createElement('div');
  div.textContent = valor ?? '';
  return div.innerHTML;
}

function processoCombina(processo, textoBusca, statusFiltro) {
  if (statusFiltro && processo.status !== statusFiltro) return false;
  if (!textoBusca) return true;
  const alvo = [
    processo.cliente,
    processo.titularDocumento,
    processo.titularNome,
    processo.numeroProcesso,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return alvo.includes(textoBusca);
}

function renderizarTabela(processos) {
  const textoBusca = elFiltroTexto.value.trim().toLowerCase();
  const statusFiltro = elFiltroStatus.value;
  const filtrados = processos.filter((p) => processoCombina(p, textoBusca, statusFiltro));

  if (filtrados.length === 0) {
    elCorpoTabela.innerHTML =
      '<tr><td colspan="10" class="linha-vazia">nenhum processo encontrado</td></tr>';
    return;
  }

  elCorpoTabela.innerHTML = filtrados
    .map((p) => {
      const erro = p.erroMensagem ? `${p.erroTipo ?? ''}: ${p.erroMensagem}` : '';
      return `
        <tr>
          <td class="mono">${p.posicao}</td>
          <td>${escaparHtml(p.fila)}</td>
          <td>${escaparHtml(p.cliente ?? '')}</td>
          <td title="${escaparHtml(p.titularNome ?? '')}">${escaparHtml(p.titularDocumento)}</td>
          <td class="mono">${escaparHtml(p.numeroProcesso)}</td>
          <td><span class="pilula-status ${classePilulaStatus(p.status)}">${formatarStatus(p.status)}</span></td>
          <td class="mono">${p.tentativas}</td>
          <td class="mono">${escaparHtml(p.nossoNumero ?? '')}</td>
          <td class="mono">${escaparHtml(p.valorGru ?? '')}</td>
          <td title="${escaparHtml(erro)}">${escaparHtml(erro)}</td>
        </tr>
      `;
    })
    .join('');
}

async function buscarStatus() {
  const resposta = await fetch('/api/status');
  if (!resposta.ok) throw new Error(`status ${resposta.status}`);
  return resposta.json();
}

async function atualizar() {
  try {
    const payload = await buscarStatus();
    ultimoStatusPayload = payload;

    const total = Object.values(payload.contagens).reduce((a, b) => a + b, 0);
    renderizarOperacao(payload.operacao);
    renderizarAlertaCategoria(payload.operacao);
    renderizarProcessoOperacao(payload.processoOperacao);
    renderizarMetricas(payload.contagens, total);
    atualizarOpcoesFiltro(payload.contagens);
    renderizarTabela(payload.processos);

    elUltimaAtualizacao.textContent = `atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch (erro) {
    elUltimaAtualizacao.textContent = `falha ao atualizar: ${erro.message}`;
  }
}

elFiltroTexto.addEventListener('input', () => {
  if (ultimoStatusPayload) renderizarTabela(ultimoStatusPayload.processos);
});
elFiltroStatus.addEventListener('change', () => {
  if (ultimoStatusPayload) renderizarTabela(ultimoStatusPayload.processos);
});

elBtnRetomar.addEventListener('click', async () => {
  elBtnRetomar.disabled = true;
  try {
    const resposta = await fetch('/api/retomar', { method: 'POST' });
    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => ({}));
      throw new Error(corpo.erro ?? `status ${resposta.status}`);
    }
    await atualizar();
  } catch (erro) {
    alert(`não foi possível retomar: ${erro.message}`);
  } finally {
    elBtnRetomar.disabled = false;
  }
});

elBtnDescartarAlerta.addEventListener('click', async () => {
  elBtnDescartarAlerta.disabled = true;
  try {
    await fetch('/api/alerta-categoria/descartar', { method: 'POST' });
    await atualizar();
  } finally {
    elBtnDescartarAlerta.disabled = false;
  }
});

async function carregarConfigPadrao() {
  try {
    const resposta = await fetch('/api/config');
    if (!resposta.ok) return;
    const config = await resposta.json();
    elCampoMaxWorkers.value = config.maxWorkers;
    elCampoPausaMin.value = config.pausaEntreAcoesMinMs;
    elCampoPausaMax.value = config.pausaEntreAcoesMaxMs;
    elCampoLargadaMin.value = config.largadaWorkerMinMs;
    elCampoLargadaMax.value = config.largadaWorkerMaxMs;
    elCampoVerificadorMin.value = config.verificadorIntervaloMinMs;
    elCampoVerificadorMax.value = config.verificadorIntervaloMaxMs;
  } catch {
    // formulário fica com placeholder vazio — não é bloqueante.
  }
}

elFormImportar.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const arquivo = elCampoPlanilha.files[0];
  if (!arquivo) return;

  elBtnImportar.disabled = true;
  elResultadoImportar.className = 'resultado-importar';
  elResultadoImportar.textContent = 'importando…';

  try {
    const formData = new FormData();
    formData.append('planilha', arquivo);
    const resposta = await fetch('/api/importar', { method: 'POST', body: formData });
    const corpo = await resposta.json();
    if (!resposta.ok) throw new Error(corpo.erro ?? `status ${resposta.status}`);

    elResultadoImportar.className = 'resultado-importar resultado-importar--sucesso';
    elResultadoImportar.textContent =
      `${corpo.totalNaPlanilha} linha(s) na planilha — ` +
      `${corpo.validados} validada(s), ${corpo.pendenciaDados} pendência de dados, ` +
      `${corpo.pendenciaLimite} pendência de limite, ${corpo.errosDeFormato.length} rejeitada(s) no schema.`;
    elFormImportar.reset();
    await atualizar();
  } catch (erro) {
    elResultadoImportar.className = 'resultado-importar resultado-importar--erro';
    elResultadoImportar.textContent = `falha ao importar: ${erro.message}`;
  } finally {
    elBtnImportar.disabled = false;
  }
});

function valorOuIndefinido(el) {
  return el.value === '' ? undefined : Number(el.value);
}

elFormIniciar.addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const confirmado = confirm(
    'Isso inicia a automação de verdade (npm run operar) — vai emitir GRUs reais assim que a cota abrir. Confirma?',
  );
  if (!confirmado) return;

  elBtnIniciar.disabled = true;
  elResultadoIniciar.className = 'resultado-importar';
  elResultadoIniciar.textContent = 'iniciando…';

  const overrides = {
    maxWorkers: valorOuIndefinido(elCampoMaxWorkers),
    pausaEntreAcoesMinMs: valorOuIndefinido(elCampoPausaMin),
    pausaEntreAcoesMaxMs: valorOuIndefinido(elCampoPausaMax),
    largadaWorkerMinMs: valorOuIndefinido(elCampoLargadaMin),
    largadaWorkerMaxMs: valorOuIndefinido(elCampoLargadaMax),
    verificadorIntervaloMinMs: valorOuIndefinido(elCampoVerificadorMin),
    verificadorIntervaloMaxMs: valorOuIndefinido(elCampoVerificadorMax),
  };

  try {
    const resposta = await fetch('/api/iniciar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides),
    });
    const corpo = await resposta.json();
    if (!resposta.ok) throw new Error(corpo.erro ?? `status ${resposta.status}`);

    elResultadoIniciar.className = 'resultado-importar resultado-importar--sucesso';
    elResultadoIniciar.textContent = `operação iniciada (pid ${corpo.pid}).`;
    await atualizar();
  } catch (erro) {
    elResultadoIniciar.className = 'resultado-importar resultado-importar--erro';
    elResultadoIniciar.textContent = `falha ao iniciar: ${erro.message}`;
    elBtnIniciar.disabled = false;
  }
});

elBtnParar.addEventListener('click', async () => {
  const confirmado = confirm(
    'Parar a operação? Cada worker termina o item que está processando agora antes de encerrar — não é instantâneo.',
  );
  if (!confirmado) return;

  elBtnParar.disabled = true;
  try {
    await fetch('/api/parar', { method: 'POST' });
    elResultadoIniciar.className = 'resultado-importar';
    elResultadoIniciar.textContent = 'sinal de parada enviado — aguardando os workers encerrarem.';
    await atualizar();
  } finally {
    elBtnParar.disabled = false;
  }
});

async function atualizarLog() {
  try {
    const resposta = await fetch('/api/log');
    if (!resposta.ok) return;
    const corpo = await resposta.json();
    const estavaNoFim =
      elLogOperacao.scrollTop + elLogOperacao.clientHeight >= elLogOperacao.scrollHeight - 4;
    elLogOperacao.textContent = corpo.linhas.length > 0 ? corpo.linhas.join('\n') : 'nada ainda…';
    if (estavaNoFim) {
      elLogOperacao.scrollTop = elLogOperacao.scrollHeight;
    }
  } catch {
    // painel continua com o último log conhecido — não é crítico.
  }
}

carregarConfigPadrao();
atualizar();
atualizarLog();
setInterval(atualizar, INTERVALO_POLLING_MS);
setInterval(atualizarLog, INTERVALO_LOG_MS);
