const elForm = document.getElementById('form-login');
const elCampoSenha = document.getElementById('campo-senha');
const elBtnEntrar = document.getElementById('btn-entrar');
const elErroLogin = document.getElementById('erro-login');

// Se já tem sessão válida (cookie), não precisa passar pelo login de novo.
fetch('/api/status')
  .then((resposta) => {
    if (resposta.ok) window.location.href = '/';
  })
  .catch(() => {
    // sem conexão ainda — fica na tela de login mesmo, tenta de novo ao enviar o form.
  });

elForm.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  elBtnEntrar.disabled = true;
  elErroLogin.classList.add('oculto');

  try {
    const resposta = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: elCampoSenha.value }),
    });
    const corpo = await resposta.json();
    if (!resposta.ok) throw new Error(corpo.erro ?? `status ${resposta.status}`);

    window.location.href = '/';
  } catch (erro) {
    elErroLogin.textContent = erro.message;
    elErroLogin.classList.remove('oculto');
    elCampoSenha.value = '';
    elCampoSenha.focus();
  } finally {
    elBtnEntrar.disabled = false;
  }
});
