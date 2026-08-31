import ExcelJS from 'exceljs';

const CAMINHO_SAIDA = new URL('../output/planilha-modelo-gru.xlsx', import.meta.url);

const workbook = new ExcelJS.Workbook();
workbook.creator = 'Sistema de emissão automatizada de GRU 3020 (INPI)';
workbook.created = new Date(2026, 7, 24);

// ---------------------------------------------------------------------------
// Aba 1 — Instruções
// ---------------------------------------------------------------------------
const instrucoes = workbook.addWorksheet('Instruções');
instrucoes.columns = [{ width: 24 }, { width: 100 }];

const tituloInstrucoes = instrucoes.addRow(['Modelo de planilha — Requerimentos de GRU 3020 (INPI)']);
tituloInstrucoes.font = { bold: true, size: 14 };
instrucoes.mergeCells('A1:B1');

instrucoes.addRow([]);
instrucoes.addRow(['Como usar', 'Preencha a aba "Processos" com um requerimento por linha. Não altere os nomes das colunas (linha 1) nem a ordem delas — o sistema lê a planilha por esse cabeçalho.']).font = { wrap: true };

instrucoes.addRow([]);
const cabecalhoCampos = instrucoes.addRow(['Campo', 'Descrição']);
cabecalhoCampos.font = { bold: true };
cabecalhoCampos.eachCell((cell) => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
});

const campos = [
  ['cliente', 'Opcional. Nome do cliente/escritório para sua própria referência interna. Não é usado pelo robô.'],
  ['titular_documento', 'OBRIGATÓRIO. CPF ou CNPJ do titular do processo, já cadastrado no INPI. Pode ser digitado com ou sem pontuação (ex.: 111.444.777-35 ou 11144477735).'],
  ['titular_nome', 'Opcional. Nome do titular, apenas para conferência visual — não é enviado ao INPI.'],
  ['numero_processo', 'OBRIGATÓRIO. Número do processo administrativo no INPI, com 9 dígitos (ex.: 940328100).'],
  ['objeto_peticao', 'OBRIGATÓRIO. Texto do "objeto da petição" exatamente como aparece no site do INPI (ex.: TPH). Confirme o texto exato com quem opera o sistema antes de preencher em massa.'],
  ['prioridade', 'Opcional. Número inteiro usado para desempate quando o titular tiver mais requerimentos do que o limite de 10 por quadrimestre — menor número entra primeiro. Deixe em branco se não houver preferência (nesse caso a ordem da planilha decide).'],
  ['protocolos_ja_utilizados', 'Opcional (padrão 0). Quantidade de requerimentos de trâmite prioritário que esse titular (CPF/CNPJ) já usou no quadrimestre atual, contando as duas filas. O limite do INPI é 10 por titular.'],
  ['fila', 'Opcional (padrão PRINCIPAL). Use PRINCIPAL para os requerimentos a processar primeiro e RESERVA para os que só devem entrar se sobrar cota.'],
];

for (const [campo, descricao] of campos) {
  const row = instrucoes.addRow([campo, descricao]);
  row.alignment = { wrapText: true, vertical: 'top' };
  row.getCell(1).font = { bold: true };
}

instrucoes.addRow([]);
const avisoRow = instrucoes.addRow(['Atenção', 'Um mesmo titular (mesmo CPF/CNPJ) não pode ter mais de 10 requerimentos de trâmite prioritário no quadrimestre, somando PRINCIPAL + RESERVA. O que exceder o limite fica pendente para decisão manual.']);
avisoRow.font = { italic: true };
avisoRow.alignment = { wrapText: true, vertical: 'top' };

instrucoes.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

// ---------------------------------------------------------------------------
// Aba 2 — Processos (planilha a preencher)
// ---------------------------------------------------------------------------
const colunas = [
  { header: 'cliente', key: 'cliente', width: 20 },
  { header: 'titular_documento', key: 'titular_documento', width: 20 },
  { header: 'titular_nome', key: 'titular_nome', width: 24 },
  { header: 'numero_processo', key: 'numero_processo', width: 18 },
  { header: 'objeto_peticao', key: 'objeto_peticao', width: 16 },
  { header: 'prioridade', key: 'prioridade', width: 12 },
  { header: 'protocolos_ja_utilizados', key: 'protocolos_ja_utilizados', width: 22 },
  { header: 'fila', key: 'fila', width: 14 },
];

const processos = workbook.addWorksheet('Processos');
processos.columns = colunas;

const headerRow = processos.getRow(1);
headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
headerRow.eachCell((cell) => {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
});
processos.views = [{ state: 'frozen', ySplit: 1 }];

// Linha de exemplo (comentada visualmente em itálico/cinza) para orientar o preenchimento.
const exemplo = processos.addRow({
  cliente: 'Cliente A',
  titular_documento: '111.444.777-35',
  titular_nome: 'Fulano de Tal',
  numero_processo: '940328100',
  objeto_peticao: 'TPH',
  prioridade: 1,
  protocolos_ja_utilizados: 0,
  fila: 'PRINCIPAL',
});
exemplo.font = { italic: true, color: { argb: 'FF808080' } };
exemplo.eachCell((cell) => {
  cell.note = 'Linha de exemplo — apague antes de enviar, ou sobrescreva com dados reais.';
});

// Validação de dados (dropdown) para a coluna "fila" nas próximas 500 linhas.
for (let i = 2; i <= 501; i += 1) {
  processos.getCell(`H${i}`).dataValidation = {
    type: 'list',
    allowBlank: true,
    formulae: ['"PRINCIPAL,RESERVA"'],
    showErrorMessage: true,
    errorTitle: 'Valor inválido',
    error: 'Use apenas PRINCIPAL ou RESERVA.',
  };
}

await workbook.xlsx.writeFile(CAMINHO_SAIDA.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
console.log('Planilha gerada em:', CAMINHO_SAIDA.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
