const INTERVALO_POLLING_MS = 3000;

const elBadge = document.getElementById('status-badge');
const elMotivo = document.getElementById('status-motivo');
const elBtnRetomar = document.getElementById('btn-retomar');
const elMetricas = document.getElementById('metricas');
const elFiltroTexto = document.getElementById('filtro-texto');
const elFiltroStatus = document.getElementById('filtro-status');
const elCorpoTabela = document.getElementById('corpo-tabela');
const elUltimaAtualizacao = document.getElementById('ultima-atualizacao');

let ultimoStatusPayload = null;

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

atualizar();
setInterval(atualizar, INTERVALO_POLLING_MS);
