# Vionza Studio — versão inicial Cloudflare

Aplicação web estática servida por Cloudflare Workers, com backend no mesmo Worker. Esta versão é focada em testar o fluxo com baixo custo e sem administrar um servidor Linux.

## O que faz

- Busca partidas por data na API `football-data.org`.
- Lê a lista M3U configurada no segredo `M3U_URL` e extrai **somente nomes e categorias dos canais**. Endereços de transmissão não são enviados ao navegador.
- Permite associar manualmente um canal a cada partida selecionada.
- Gera um fundo esportivo pela OpenAI Images API.
- Compõe os textos e dados dos jogos no navegador e exporta a arte final como PNG.
- Guarda as associações de canais em `localStorage` do navegador usado; não há contas de usuários nem banco de dados persistente nesta primeira versão.

## Antes de publicar

**Não publiques a aplicação aberta para qualquer pessoa ainda.** O endpoint de geração de imagem consome a tua API paga. A aplicação agora exige senha única configurada por `APP_PASSWORD` e assina uma sessão por `SESSION_SECRET`. Usa uma senha forte, não a compartilhes e troca-a se houver suspeita de exposição. Antes de partilhar o endereço com outras pessoas, adiciona também limites de uso/geração e considera Cloudflare Access. Configura limites de gastos/alertas na conta da API de imagens.

Usa somente uma lista M3U que tenhas autorização para consultar e usar desta forma. Esta aplicação não reproduz os canais nem distribui os links de transmissão. A importação da lista pode falhar se o provedor bloquear requisições originadas do Cloudflare, exigir um cabeçalho específico ou limitar acessos por IP.

## Contas necessárias

1. Cloudflare: https://dash.cloudflare.com/
2. football-data.org (para partidas): https://www.football-data.org/client/register
3. OpenAI API (para imagens): https://platform.openai.com/api-keys

A cobertura da API esportiva varia por plano. A API não informa automaticamente o canal que transmite cada partida. A associação canal-jogo é manual nesta versão.

## Publicação usando o terminal

Requisitos: Node.js 20+ instalado no computador.

1. Extrai o ZIP numa pasta local.
2. Abre um terminal nessa pasta e executa:
   ```bash
   npm install
   npx wrangler login
   ```
3. Configura os segredos um a um. O terminal vai pedir o valor; cola o conteúdo diretamente ali, não no chat:
   ```bash
   npx wrangler secret put APP_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put FOOTBALL_DATA_API_KEY
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put M3U_URL
   ```
   Para `APP_PASSWORD`, cria uma senha forte exclusiva para o Vionza Studio. Para `SESSION_SECRET`, usa uma sequência aleatória longa, diferente da senha.
4. Opcionalmente, se a tua conta usar outro modelo de imagem, define:
   ```bash
   npx wrangler secret put OPENAI_IMAGE_MODEL
   ```
   Ao pedir o valor, informa o identificador de modelo habilitado na tua conta. O padrão do projeto é `gpt-image-1`.
5. Testa localmente (as chaves locais ficam em `.dev.vars`, que não deve ser enviada a ninguém):
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   Edita `.dev.vars` e coloca os valores reais. Depois executa:
   ```bash
   npm run dev
   ```
6. Para publicar:
   ```bash
   npm run deploy
   ```
   O Cloudflare fornecerá um endereço de teste. Antes de divulgar, configura Cloudflare Access ou outro controle de acesso para impedir que terceiros gastem a tua cota de geração.

No Windows PowerShell, se `cp` não funcionar, usa `Copy-Item .dev.vars.example .dev.vars`.

## Como configurar a M3U

O segredo `M3U_URL` deve conter o link completo da lista M3U, inclusive os parâmetros que o provedor exige. Não coloques o link no HTML, em `wrangler.toml`, em repositório público nem em mensagens. Não é necessário me enviar o link.

O endpoint `/api/channels` retorna apenas `id`, `name` e `category`; nunca retorna as URLs de transmissão. A aplicação impõe um limite inicial de 5 MB e 2.000 canais processados para evitar consumo excessivo de recursos. Alguns provedores podem rejeitar o acesso a partir de datacenters; nesse caso, precisamos verificar os termos e o método de acesso autorizado do provedor, sem tentar contornar controles de acesso.

## Rotas

- `GET /api/health` — mostra se as três integrações estão configuradas, sem revelar segredos.
- `GET /api/channels` — lê a M3U privada e devolve nomes/categorias.
- `GET /api/matches?date=AAAA-MM-DD` — consulta partidas do dia.
- `POST /api/generate-background` — gera um fundo por IA.

## Limitações desta primeira versão

- Sem login próprio, contas de usuários, cobrança ou painel administrativo.
- Sem banco persistente; associações canal-jogo ficam no navegador atual.
- Sem associação automática entre partidas e canais; precisa ser feita manualmente e conferida.
- Sem escudos garantidos; a cobertura e os direitos de uso de imagens de times dependem da fonte.
- Sem armazenamento permanente dos fundos gerados: a imagem é devolvida ao navegador para compor e baixar a arte.
- A geração de imagens pode ter custo por chamada; testa com poucas gerações antes de uso recorrente.
