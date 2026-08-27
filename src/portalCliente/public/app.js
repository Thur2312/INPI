const CHAVE_SESSAO = 'portalCliente.sessao';

const elTelaLogin = document.getElementById('tela-login');
const elTelaLista = document.getElementById('tela-lista');
const elFormLogin = document.getElementById('form-login');
const elCampoDocumento = document.getElementById('campo-documento');
const elBtnEntrar = document.getElementById('btn-entrar');
const elErroLogin = document.getElementById('erro-login');
const elBtnSair = document.getElementById('btn-sair');
const elListaProcessos = document.getElementById('lista-processos');
const elTituloLista = document.getElementById('titulo-lista');

/**
 * Rótulo em linguagem simples pro titular final — os status técnicos
 * (ex.: ERRO_CLIENTE_NAO_ENCONTRADO) são vocabulário interno da operação,
 * não algo que o cliente do cliente deveria ler cru. Ver `STATUS`/
 * `STATUS_EXCECAO` em `src/domain/types.ts`.
 */
const MAPA_STATUS = {
  IMPORTADO: { rotulo: 'Recebido', classe: 'neutro' },
  VALIDANDO: { rotulo: 'Em validação', classe: 'neutro' },
  VALIDADO: { rotulo: 'Na fila', classe: 'neutro' },
  AGUARDANDO_ABERTURA: { rotulo: 'Aguardando abertura da cota', classe: 'alerta' },
  GRU_EM_PROCESSAMENTO: { rotulo: 'Em processamento', classe: 'alerta' },
  GRU_EMITIDA: { rotulo: 'Guia emitida', classe: 'sucesso' },
  PENDENCIA_DADOS: { rotulo: 'Pendência de dados', classe: 'alerta' },
  PENDENCIA_LIMITE: { rotulo: 'Limite por titular atingido', classe: 'alerta' },
  ERRO_CLIENTE_NAO_ENCONTRADO: { rotulo: 'Titular não localizado no INPI', classe: 'erro' },
  ERRO_CLIENTE_AMBIGUO: { rotulo: 'Precisa de revisão manual', classe: 'erro' },
  ERRO_OBJETO_INDISPONIVEL: { rotulo: 'Categoria ainda não disponível', classe: 'alerta' },
  ERRO_VALOR_INESPERADO: { rotulo: 'Valor da guia divergente', classe: 'erro' },
  ERRO_TIMEOUT: { rotulo: 'Nova tentativa em andamento', classe: 'alerta' },
  ERRO_SESSAO: { rotulo: 'Nova tentativa em andamento', classe: 'alerta' },
  ERRO_CAPTCHA: { rotulo: 'Verificação de segurança do INPI', classe: 'alerta' },
  ERRO_DESCONHECIDO: { rotulo: 'Em análise', classe: 'erro' },
  EMISSAO_INCERTA: { rotulo: 'Em verificação', classe: 'alerta' },
};

function statusInfo(status) {
  return MAPA_STATUS[status] ?? { rotulo: status.replaceAll('_', ' '), classe: 'neutro' };
}

function lerSessao() {
  try {
    const bruto = localStorage.getItem(CHAVE_SESSAO);
    return bruto ? JSON.parse(bruto) : null;
  } catch {
    return null;
  }
}

function gravarSessao(sessao) {
  try {
    localStorage.setItem(CHAVE_SESSAO, JSON.stringify(sessao));
  } catch {
    // localStorage indisponível (modo privado etc.) — sessão só dura a aba atual, sem quebrar o fluxo.
  }
}

function limparSessao() {
  try {
    localStorage.removeItem(CHAVE_SESSAO);
  } catch {
    // ver gravarSessao
  }
}

function mostrarLogin() {
  elTelaLogin.classList.remove('oculto');
  elTelaLista.classList.add('oculto');
  elBtnSair.classList.add('oculto');
}

function mostrarLista() {
  elTelaLogin.classList.add('oculto');
  elTelaLista.classList.remove('oculto');
  elBtnSair.classList.remove('oculto');
}

function formatarData(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('pt-BR');
  } catch {
    return null;
  }
}

function renderizarProcessos(processos) {
  elTituloLista.textContent =
    processos.length === 1 ? '1 requerimento' : `${processos.length} requerimentos`;

  if (processos.length === 0) {
    elListaProcessos.innerHTML = '<div class="estado-vazio">Nenhum requerimento encontrado ainda.</div>';
    return;
  }

  elListaProcessos.innerHTML = processos
    .map((p) => {
      const info = statusInfo(p.status);
      const dataRef = formatarData(p.concluidoEm) ?? formatarData(p.criadoEm);
      const classeCartao =
        info.classe === 'erro'
          ? 'processo-cartao--erro'
          : info.classe === 'sucesso'
            ? 'processo-cartao--sucesso'
            : '';

      // Emitida sem PDF disponível é um estado real, não só teórico: ver
      // `tratarEmissaoIncerta` em `workerLoop.ts` — a reconciliação pode
      // confirmar a guia e marcar emitida mesmo com o download da 2ª via
      // tendo falhado. Nesse caso "ainda não emitida" seria enganoso (dá
      // a entender que é só esperar), por isso um texto diferente aqui.
      const acao = p.pdfDisponivel
        ? `<button class="botao botao--secundario" data-baixar="${p.id}" data-processo="${p.numeroProcesso}">Baixar guia</button>`
        : p.status === 'GRU_EMITIDA'
          ? '<span class="sem-guia">Arquivo indisponível — fale com o suporte</span>'
          : '<span class="sem-guia">Guia ainda não emitida</span>';

      return `
        <article class="processo-cartao ${classeCartao}">
          <div class="processo-info">
            <span class="processo-numero">Processo ${p.numeroProcesso}</span>
            <span class="processo-objeto">${escaparHtml(p.objetoPeticao)}</span>
            <span class="processo-meta">${dataRef ? `Atualizado em ${dataRef}` : ''}</span>
          </div>
          <div class="processo-acao">
            <span class="pilula pilula--${info.classe}">${info.rotulo}</span>
            ${p.valorGru ? `<span class="processo-valor">R$ ${escaparHtml(p.valorGru)}</span>` : ''}
            ${acao}
          </div>
        </article>
      `;
    })
    .join('');
}

function escaparHtml(valor) {
  const div = document.createElement('div');
  div.textContent = valor ?? '';
  return div.innerHTML;
}

async function carregarProcessos(token) {
  const resposta = await fetch('/api/minhas-grus', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resposta.ok) {
    throw new Error(resposta.status === 401 ? 'sessão expirada' : `status ${resposta.status}`);
  }
  const corpo = await resposta.json();
  return corpo.processos;
}

async function tentarSessaoExistente() {
  const sessao = lerSessao();
  if (!sessao?.token) {
    mostrarLogin();
    return;
  }
  try {
    const processos = await carregarProcessos(sessao.token);
    renderizarProcessos(processos);
    mostrarLista();
  } catch {
    limparSessao();
    mostrarLogin();
  }
}

elFormLogin.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const documento = elCampoDocumento.value.trim();
  if (!documento) return;

  elBtnEntrar.disabled = true;
  elErroLogin.classList.add('oculto');

  try {
    const resposta = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documento }),
    });
    const corpo = await resposta.json();
    if (!resposta.ok) throw new Error(corpo.erro ?? `status ${resposta.status}`);

    gravarSessao({ token: corpo.token, documento, obtidoEm: Date.now() });
    const processos = await carregarProcessos(corpo.token);
    renderizarProcessos(processos);
    mostrarLista();
    elFormLogin.reset();
  } catch (erro) {
    elErroLogin.textContent = erro.message;
    elErroLogin.classList.remove('oculto');
  } finally {
    elBtnEntrar.disabled = false;
  }
});

elListaProcessos.addEventListener('click', async (evento) => {
  const botao = evento.target.closest('[data-baixar]');
  if (!botao) return;

  const sessao = lerSessao();
  if (!sessao?.token) {
    mostrarLogin();
    return;
  }

  const idProcesso = botao.getAttribute('data-baixar');
  const numeroProcesso = botao.getAttribute('data-processo');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Baixando…';

  try {
    const resposta = await fetch(`/api/grus/${idProcesso}/pdf`, {
      headers: { authorization: `Bearer ${sessao.token}` },
    });
    if (!resposta.ok) throw new Error(`status ${resposta.status}`);

    const blob = await resposta.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `GRU-${numeroProcesso}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (erro) {
    alert(`não foi possível baixar a guia: ${erro.message}`);
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
});

elBtnSair.addEventListener('click', () => {
  limparSessao();
  mostrarLogin();
});

tentarSessaoExistente();
