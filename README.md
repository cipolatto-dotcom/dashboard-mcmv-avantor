# Dashboard MCMV – Avantor Imóveis

Dashboard de funil de vendas MCMV integrado com GoHighLevel, hospedado no Railway.

## Deploy no Railway

### Opção 1 — Via GitHub (recomendado)

1. Crie um repositório no GitHub e suba estes arquivos
2. Acesse [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Selecione o repositório
4. O Railway detecta automaticamente o `railway.toml` e faz o build

### Opção 2 — Via Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Variáveis de ambiente (opcional)

No painel do Railway → **Variables**, você pode sobrescrever:

| Variável    | Padrão         | Descrição                        |
|-------------|----------------|----------------------------------|
| GHL_TOKEN   | (embutido)     | Token de acesso GHL              |
| GHL_LOC     | (embutido)     | Location ID do GHL               |
| GHL_PIPE    | (embutido)     | Pipeline ID MCMV                 |
| CACHE_TTL   | 60000          | Tempo de cache em ms (padrão 60s)|
| PORT        | 3000           | Porta do servidor                |

## Embedar no GHL

Após o deploy, copie a URL gerada pelo Railway (ex: `https://dashboard-mcmv.up.railway.app`) e adicione no GHL:

**Reporting → Dashboards → + Add Widget → iFrame/HTML → cole a URL**

## Rotas disponíveis

| Rota       | Descrição                              |
|------------|----------------------------------------|
| `GET /`    | Dashboard HTML completo                |
| `GET /api/data` | Dados brutos em JSON            |

## Atualização dos dados

O servidor mantém um cache de 60 segundos. A página usa `<meta http-equiv="refresh">` para recarregar automaticamente no mesmo intervalo, garantindo dados sempre frescos sem sobrecarregar a API do GHL.
