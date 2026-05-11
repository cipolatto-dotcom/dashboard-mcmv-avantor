const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Configuração GHL ──────────────────────────────────────────────────────────
const GHL_TOKEN = process.env.GHL_TOKEN;
const GHL_LOC   = process.env.GHL_LOC;
const GHL_PIPE  = process.env.GHL_PIPE;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "60000");

if (!GHL_TOKEN || !GHL_LOC || !GHL_PIPE) {
  console.error("ERRO: variáveis GHL_TOKEN, GHL_LOC e GHL_PIPE são obrigatórias.");
  process.exit(1);
}

const STAGES = [
  { id: "cf6c826a-7a17-464f-9dbb-3a2d40c3d76a", name: "Novo Lead"   },
  { id: "1f732a3b-ec6d-452b-9530-7eff8fd6c3b9", name: "Atendimento" },
  { id: "1defe615-8cbc-449c-8202-a67c5b65b1ba", name: "Simulação"   },
  { id: "c321098d-4581-477f-8cbf-46f29d05fec0", name: "Visita"      },
  { id: "a97c5461-39a1-40c7-8f0d-a24ec2109e9f", name: "Aprovação"   },
  { id: "4a5ff2d0-dd4b-4ac9-bc83-56669cf485cd", name: "Negociação"  },
];

// ── Cache simples em memória ──────────────────────────────────────────────────
let cache = { data: null, ts: 0 };

async function fetchAllOpps() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;

  const stageMap = {};
  STAGES.forEach(s => {
    stageMap[s.id] = { name: s.name, open: 0, lost: 0, won: 0,
                       open_val: 0, lost_val: 0, won_val: 0 };
  });

  let url = `https://services.leadconnectorhq.com/opportunities/search` +
            `?location_id=${GHL_LOC}&pipeline_id=${GHL_PIPE}&limit=100`;
  let pages = 0;

  while (url && pages < 30) {
    const res  = await fetch(url, {
      headers: { "Authorization": `Bearer ${GHL_TOKEN}`, "Version": "2021-07-28" }
    });
    const json = await res.json();
    const opps = json.opportunities || [];

    for (const opp of opps) {
      const sid    = opp.pipelineStageId;
      const status = opp.status || "open";
      const val    = opp.monetaryValue || 0;
      if (stageMap[sid]) {
        stageMap[sid][status]           = (stageMap[sid][status]           || 0) + 1;
        stageMap[sid][`${status}_val`]  = (stageMap[sid][`${status}_val`]  || 0) + val;
      }
    }

    const next = json.meta?.nextPageUrl;
    url = (next && opps.length === 100) ? next : null;
    pages++;
  }

  // Totais globais
  let total = 0, open = 0, lost = 0, won = 0, won_val = 0;
  for (const s of Object.values(stageMap)) {
    total   += s.open + s.lost + s.won;
    open    += s.open;
    lost    += s.lost;
    won     += s.won;
    won_val += s.won_val;
  }

  const result = {
    stages: STAGES.map(s => ({ ...s, ...stageMap[s.id] })),
    totals: { total, open, lost, won, won_val },
    updatedAt: new Date().toISOString(),
  };

  cache = { data: result, ts: Date.now() };
  return result;
}

// ── Rota JSON (para debug / integrações futuras) ──────────────────────────────
app.get("/api/data", async (req, res) => {
  try {
    res.json(await fetchAllOpps());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rota principal: dashboard HTML ────────────────────────────────────────────
app.get("/", async (req, res) => {
  let data;
  try { data = await fetchAllOpps(); }
  catch (e) {
    return res.status(500).send(`<pre>Erro ao buscar dados GHL: ${e.message}</pre>`);
  }

  const { stages, totals, updatedAt } = data;
  const maxTotal = Math.max(...stages.map(s => s.open + s.lost + s.won), 1);

  function fmtN(n)   { return (n || 0).toLocaleString("pt-BR"); }
  function fmtCur(n) {
    if (!n) return "R$ 0";
    if (n >= 1e6) return "R$ " + (n/1e6).toFixed(1) + "M";
    if (n >= 1e3) return "R$ " + (n/1e3).toFixed(0) + "k";
    return "R$ " + n.toLocaleString("pt-BR");
  }
  function fmtPct(a, b) {
    if (!b || !a) return "0%";
    return (a / b * 100).toFixed(1) + "%";
  }
  function convClass(a, b) {
    const p = b ? a/b*100 : 0;
    if (p >= 50) return "good";
    if (p >= 10) return "warn";
    return "bad";
  }
  function updFmt(iso) {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day:"2-digit", month:"2-digit", year:"numeric",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
  }

  const COLORS = [
    "#64748b","#3b82f6","#06b6d4","#8b5cf6","#f59e0b","#f97316"
  ];

  // Linhas do funil
  const funnelRows = stages.map((s, i) => {
    const total  = s.open + s.lost + s.won;
    const width  = Math.max((total / maxTotal) * 100, total > 0 ? 5 : 1);
    const color  = COLORS[i];
    const prev   = i > 0 ? (stages[i-1].open + stages[i-1].lost + stages[i-1].won) : null;
    const convRow = i > 0 ? `
      <div class="conv-row">
        <div class="conv-line"></div>
        <span class="conv-badge ${convClass(total, prev)}">
          ${fmtPct(total, prev)} conv. &middot; ${fmtN(total)} de ${fmtN(prev)}
        </span>
      </div>` : "";

    return `${convRow}
    <div class="funnel-row">
      <div class="stage-label">${s.name}</div>
      <div class="bar-wrap">
        <div class="bar" style="width:${width}%;background:${color}18;border:1px solid ${color}44;">
          <span class="bar-total" style="color:${color};">${fmtN(total)}</span>
          <div class="bar-badges">
            ${s.open > 0 ? `<span class="badge open">${fmtN(s.open)} open</span>` : ""}
            ${s.won  > 0 ? `<span class="badge won">${fmtN(s.won)} won</span>`   : ""}
            ${s.lost > 0 ? `<span class="badge lost">${fmtN(s.lost)} lost</span>` : ""}
          </div>
        </div>
      </div>
      <div class="stage-meta">
        <span class="meta-pct" style="color:${color};">${i === 0 ? "100%" : fmtPct(total, stages[0].open + stages[0].lost + stages[0].won)}</span>
        <span class="meta-val">${fmtCur(s.open_val + s.won_val)}</span>
      </div>
    </div>`;
  }).join("");

  // Breakdown open/lost/won
  function breakSection(field, label, color) {
    const rows = stages
      .filter(s => s[field] > 0)
      .map(s => `
        <div class="break-row">
          <span class="break-name">${s.name}</span>
          <span class="break-n" style="color:${color};">${fmtN(s[field])}</span>
        </div>`).join("") || `<div class="break-empty">Nenhum registro</div>`;
    return `<div class="break-card">
      <div class="break-title">${label}</div>
      ${rows}
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${CACHE_TTL/1000}">
<title>Dashboard MCMV – Avantor</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0f1117;--s1:#181c27;--s2:#1e2333;
    --bd:rgba(255,255,255,.07);
    --tx:#e8eaf0;--mu:#6b7280;
    --green:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#3b82f6;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--tx);
       min-height:100vh;padding:20px;font-size:14px;}

  /* HEADER */
  .hdr{display:flex;align-items:center;justify-content:space-between;
       margin-bottom:22px;padding-bottom:14px;border-bottom:1px solid var(--bd);}
  .hdr-l{display:flex;align-items:center;gap:12px;}
  .logo{width:34px;height:34px;border-radius:9px;
        background:linear-gradient(135deg,#3b82f6,#8b5cf6);
        display:flex;align-items:center;justify-content:center;
        font-size:15px;font-weight:700;color:#fff;}
  .hdr-title{font-size:15px;font-weight:600;}
  .hdr-sub{font-size:11px;color:var(--mu);margin-top:2px;}
  .hdr-r{display:flex;align-items:center;gap:10px;}
  .pill{display:flex;align-items:center;gap:6px;
        background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);
        border-radius:20px;padding:4px 12px;font-size:12px;color:var(--green);
        font-family:'DM Mono',monospace;}
  .pulse{width:6px;height:6px;border-radius:50%;background:var(--green);
         animation:pulse 1.8s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
  .upd{font-size:11px;color:var(--mu);font-family:'DM Mono',monospace;}

  /* KPI */
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}
  .kpi{background:var(--s1);border:1px solid var(--bd);border-radius:12px;
       padding:15px 17px;position:relative;overflow:hidden;}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:12px 12px 0 0;}
  .kpi.bl::before{background:var(--blue);}
  .kpi.gr::before{background:var(--green);}
  .kpi.am::before{background:var(--amber);}
  .kpi.rd::before{background:var(--red);}
  .kpi-lbl{font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;}
  .kpi-val{font-size:26px;font-weight:600;font-family:'DM Mono',monospace;line-height:1;}
  .kpi.bl .kpi-val{color:#60a5fa;} .kpi.gr .kpi-val{color:var(--green);}
  .kpi.am .kpi-val{color:var(--amber);} .kpi.rd .kpi-val{color:#f87171;}
  .kpi-sub{font-size:11px;color:var(--mu);margin-top:5px;}

  /* FUNIL */
  .card{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:20px;margin-bottom:16px;}
  .sec-title{font-size:10px;font-weight:600;color:var(--mu);
             text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px;}
  .funnel-row{display:flex;align-items:center;gap:14px;margin-bottom:3px;}
  .stage-label{width:105px;flex-shrink:0;font-size:12px;color:var(--mu);text-align:right;}
  .bar-wrap{flex:1;height:38px;background:rgba(255,255,255,.03);border-radius:7px;overflow:hidden;}
  .bar{height:100%;border-radius:7px;display:flex;align-items:center;
       padding:0 12px;justify-content:space-between;min-width:52px;}
  .bar-total{font-size:13px;font-weight:600;font-family:'DM Mono',monospace;}
  .bar-badges{display:flex;gap:5px;align-items:center;}
  .badge{font-size:10px;padding:2px 6px;border-radius:8px;font-family:'DM Mono',monospace;}
  .badge.open{background:rgba(59,130,246,.15);color:#60a5fa;}
  .badge.won {background:rgba(34,197,94,.15);color:#4ade80;}
  .badge.lost{background:rgba(107,114,128,.15);color:#9ca3af;}
  .stage-meta{width:110px;flex-shrink:0;display:flex;flex-direction:column;gap:3px;}
  .meta-pct{font-size:12px;font-weight:500;font-family:'DM Mono',monospace;}
  .meta-val{font-size:11px;color:var(--mu);}

  /* CONV ROW */
  .conv-row{display:flex;align-items:center;gap:8px;
             padding:2px 0 2px 119px;margin-bottom:3px;}
  .conv-line{width:1px;height:13px;background:var(--bd);}
  .conv-badge{font-size:10px;font-family:'DM Mono',monospace;padding:2px 8px;border-radius:10px;}
  .conv-badge.good{background:rgba(34,197,94,.1);color:var(--green);}
  .conv-badge.warn{background:rgba(245,158,11,.1);color:var(--amber);}
  .conv-badge.bad {background:rgba(239,68,68,.1);color:#f87171;}

  /* BREAKDOWN */
  .break-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;}
  .break-card{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:16px;}
  .break-title{font-size:10px;color:var(--mu);text-transform:uppercase;
               letter-spacing:.07em;margin-bottom:12px;font-weight:600;}
  .break-row{display:flex;justify-content:space-between;align-items:center;
             margin-bottom:7px;font-size:12px;}
  .break-name{color:var(--tx);}
  .break-n{font-family:'DM Mono',monospace;font-weight:500;}
  .break-empty{font-size:12px;color:#374151;}

  /* FOOTER */
  .footer{display:flex;align-items:center;justify-content:space-between;
          padding-top:14px;border-top:1px solid var(--bd);
          font-size:11px;color:var(--mu);font-family:'DM Mono',monospace;}

  /* GANHO BANNER */
  .ganho-banner{background:linear-gradient(90deg,rgba(34,197,94,.08),rgba(34,197,94,.02));
                border:1px solid rgba(34,197,94,.2);border-radius:12px;
                padding:14px 20px;margin-bottom:16px;
                display:flex;align-items:center;justify-content:space-between;}
  .ganho-lbl{font-size:11px;color:var(--green);text-transform:uppercase;
             letter-spacing:.07em;margin-bottom:4px;}
  .ganho-val{font-size:22px;font-weight:600;font-family:'DM Mono',monospace;color:var(--green);}
  .ganho-sub{font-size:11px;color:rgba(34,197,94,.6);}
  .ganho-conv{text-align:right;}
  .ganho-conv-lbl{font-size:11px;color:var(--mu);margin-bottom:4px;}
  .ganho-conv-val{font-size:22px;font-weight:600;font-family:'DM Mono',monospace;color:#f59e0b;}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-l">
    <div class="logo">A</div>
    <div>
      <div class="hdr-title">Dashboard MCMV</div>
      <div class="hdr-sub">Avantor Imóveis &middot; Pipeline 6. MCMV</div>
    </div>
  </div>
  <div class="hdr-r">
    <div class="pill"><div class="pulse"></div>Tempo real</div>
    <div class="upd">Atualizado: ${updFmt(updatedAt)}</div>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi bl">
    <div class="kpi-lbl">Total no pipeline</div>
    <div class="kpi-val">${fmtN(totals.total)}</div>
    <div class="kpi-sub">oportunidades</div>
  </div>
  <div class="kpi bl">
    <div class="kpi-lbl">Em aberto</div>
    <div class="kpi-val">${fmtN(totals.open)}</div>
    <div class="kpi-sub">status open</div>
  </div>
  <div class="kpi gr">
    <div class="kpi-lbl">Ganhos (won)</div>
    <div class="kpi-val">${fmtN(totals.won)}</div>
    <div class="kpi-sub">${fmtCur(totals.won_val)}</div>
  </div>
  <div class="kpi rd">
    <div class="kpi-lbl">Perdidos (lost)</div>
    <div class="kpi-val">${fmtN(totals.lost)}</div>
    <div class="kpi-sub">conv. geral ${fmtPct(totals.won, totals.total)}</div>
  </div>
</div>

<div class="ganho-banner">
  <div>
    <div class="ganho-lbl">✓ Negociação → Ganho</div>
    <div class="ganho-val">${fmtN(totals.won)} contratos fechados</div>
    <div class="ganho-sub">${fmtCur(totals.won_val)} em valor total</div>
  </div>
  <div class="ganho-conv">
    <div class="ganho-conv-lbl">Conversão geral</div>
    <div class="ganho-conv-val">${fmtPct(totals.won, totals.total)}</div>
  </div>
</div>

<div class="card">
  <div class="sec-title">Funil de vendas — por etapa</div>
  ${funnelRows}
</div>

<div class="break-grid">
  ${breakSection("open", "Em aberto por etapa", "#60a5fa")}
  ${breakSection("lost", "Perdidos por etapa",  "#9ca3af")}
  ${breakSection("won",  "Ganhos por etapa",    "#4ade80")}
</div>

<div class="footer">
  <span>GHL API &middot; Pipeline ${GHL_PIPE} &middot; Cache ${CACHE_TTL/1000}s</span>
  <span>${updFmt(updatedAt)}</span>
</div>

</body>
</html>`;

  res.send(html);
});

app.listen(PORT, () => console.log(`Dashboard MCMV rodando na porta ${PORT}`));
