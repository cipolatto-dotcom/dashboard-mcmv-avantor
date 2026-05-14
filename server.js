require("dotenv").config();
const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

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

// ── Cache de dados brutos ─────────────────────────────────────────────────────
let rawCache = { opps: null, ts: 0 };

async function fetchRawOpps() {
  if (rawCache.opps && Date.now() - rawCache.ts < CACHE_TTL) return rawCache.opps;

  const all = [];
  let url = `https://services.leadconnectorhq.com/opportunities/search`
          + `?location_id=${GHL_LOC}&pipeline_id=${GHL_PIPE}&limit=100`;
  let pages = 0;

  while (url && pages < 30) {
    const res  = await fetch(url, {
      headers: { "Authorization": `Bearer ${GHL_TOKEN}`, "Version": "2021-07-28" }
    });
    const json = await res.json();
    const opps = json.opportunities || [];
    all.push(...opps);
    const next = json.meta?.nextPageUrl;
    url = (next && opps.length === 100) ? next : null;
    pages++;
  }

  rawCache = { opps: all, ts: Date.now() };
  return all;
}

// ── Processa opps com filtro de data em memória ───────────────────────────────
function processOpps(all, fromDate, toDate) {
  const stageMap = {};
  STAGES.forEach(s => {
    stageMap[s.id] = { open: 0, lost: 0, won: 0, open_val: 0, won_val: 0 };
  });
  const lostReasons  = {};
  const stageClients = STAGES.map(() => []);
  const wonClients   = [];

  const fromTs = fromDate ? new Date(fromDate + "T00:00:00").getTime() : null;
  const toTs   = toDate   ? new Date(toDate   + "T23:59:59.999").getTime() : null;

  for (const opp of all) {
    if (fromTs !== null || toTs !== null) {
      const ts = new Date(opp.createdAt).getTime();
      if (fromTs !== null && ts < fromTs) continue;
      if (toTs   !== null && ts > toTs)   continue;
    }
    const sid    = opp.pipelineStageId;
    const status = opp.status || "open";
    const val    = opp.monetaryValue || 0;
    if (!stageMap[sid]) continue;
    stageMap[sid][status] = (stageMap[sid][status] || 0) + 1;
    if (status === "open") stageMap[sid].open_val += val;
    if (status === "won")  stageMap[sid].won_val  += val;
    if (status === "lost") {
      const reason = opp.lostReason || "Não informado";
      lostReasons[reason] = (lostReasons[reason] || 0) + 1;
    }

    // Lista de clientes por etapa para o modal
    const stageIdx = STAGES.findIndex(s => s.id === sid);
    if (stageIdx !== -1) {
      stageClients[stageIdx].push({
        name:  opp.contact?.name  || opp.name || "—",
        phone: opp.contact?.phone || "—",
        email: opp.contact?.email || "—",
        value: opp.monetaryValue  || 0,
        status,
        createdAt: opp.createdAt,
      });
    }
    if (status === "won") wonClients.push({
      name:  opp.contact?.name  || opp.name || "—",
      phone: opp.contact?.phone || "—",
      email: opp.contact?.email || "—",
      value: opp.monetaryValue  || 0,
      status,
      createdAt: opp.createdAt,
    });
  }

  const stages = STAGES.map(s => ({ ...s, ...stageMap[s.id] }));
  let total = 0, open = 0, lost = 0, won = 0, won_val = 0;
  for (const s of stages) {
    total += s.open + s.lost + s.won;
    open  += s.open;
    lost  += s.lost;
    won   += s.won;
    won_val += s.won_val;
  }

  return { stages, totals: { total, open, lost, won, won_val }, lostReasons, stageClients, wonClients, updatedAt: new Date().toISOString() };
}

// ── API JSON ──────────────────────────────────────────────────────────────────
app.get("/api/data", async (req, res) => {
  try {
    res.json(processOpps(await fetchRawOpps(), req.query.from, req.query.to));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard HTML ────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  let data;
  try {
    data = processOpps(await fetchRawOpps(), req.query.from, req.query.to);
  } catch (e) {
    return res.status(500).send(`<pre>Erro: ${e.message}</pre>`);
  }

  const { stages, totals, lostReasons, stageClients, wonClients, updatedAt } = data;
  const from = req.query.from || "";
  const to   = req.query.to   || "";

  const N = n => (n || 0).toLocaleString("pt-BR");
  const P = (a, b) => (!b ? "—" : ((a / b) * 100).toFixed(1) + "%");
  const C = n => {
    if (!n) return "R$ 0";
    if (n >= 1e6) return "R$ " + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "R$ " + (n / 1e3).toFixed(0) + "k";
    return "R$ " + n.toLocaleString("pt-BR");
  };
  const fmt = iso => new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  // Detectar qual botão de filtro rápido está ativo (sempre em horário de Brasília)
  const brDate = n => new Date(n).toLocaleDateString("sv", {timeZone: "America/Sao_Paulo"});
  const todayStr = brDate(Date.now());
  const d7str    = brDate(Date.now() -  7 * 86400000);
  const d30str   = brDate(Date.now() - 30 * 86400000);
  const d90str   = brDate(Date.now() - 90 * 86400000);
  const mesStr   = todayStr.slice(0, 8) + "01"; // primeiro dia do mês em Brasília
  const activeBtn = (() => {
    if (!from && !to)                        return "todos";
    if (from === todayStr && to === todayStr) return "hoje";
    if (from === d7str    && to === todayStr) return "7d";
    if (from === d30str   && to === todayStr) return "30d";
    if (from === d90str   && to === todayStr) return "90d";
    if (from === mesStr   && to === todayStr) return "mes";
    return null;
  })();
  const qb = id => `class="qb${activeBtn === id ? " on" : ""}"`;

  const stTotals = stages.map(s => s.open + s.lost + s.won);

  // Contagem cumulativa: lead em etapa N conta também em todas as anteriores
  const stCumulative = [...stTotals];
  for (let i = stCumulative.length - 2; i >= 0; i--) {
    stCumulative[i] = stTotals[i] + stCumulative[i + 1];
  }

  const periodLabel = (() => {
    if (from && to) return `${from.split("-").reverse().join("/")} → ${to.split("-").reverse().join("/")}`;
    if (from) return `A partir de ${from.split("-").reverse().join("/")}`;
    if (to)   return `Até ${to.split("-").reverse().join("/")}`;
    return "Todos os dados";
  })();

  // ── Funil SVG estático (trapézios fixos) ─────────────────────────────────────
  const totalLeads = stCumulative[0]; // = totals.total

  const funnelStages = [
    ...stages.map((s, i) => ({
      name: s.name,
      count:    stTotals[i],     // real: pessoas nesta etapa
      cumCount: stCumulative[i], // cumulativo: para cálculo de conversão
      value: s.open_val || 0,
      isGanho: false,
    })),
    { name: "Ganho", count: totals.won, cumCount: totals.won, value: totals.won_val, isGanho: true },
  ];

  const stageDataJSON = JSON.stringify(
    funnelStages.map((fs, i) => ({
      name:    fs.name,
      clients: i < STAGES.length ? stageClients[i] : wonClients,
    }))
  );

  const SVG_CX   = 300;
  const MAX_HW   = 260;
  const MIN_HW   = 78;
  const N_SL     = funnelStages.length; // 7
  const STEP     = (MAX_HW - MIN_HW) / N_SL; // 26
  const SLICE_H  = 72;
  const GAP      = 3;
  const ROW_H    = SLICE_H + GAP; // 75
  const HEADER_H = 50; // espaço para a barra de total
  const SVG_W    = 800;
  const SVG_H    = HEADER_H + N_SL * ROW_H - GAP;
  const COLORS   = ["#0D234A","#0E2D5C","#12376E","#164180","#1B4B94","#2055A8","#16A34A"];

  // Barra de total dentro do SVG — alinha exatamente com o topo do funil
  const svgHeader = `
  <rect x="${SVG_CX - MAX_HW}" y="4" width="${2 * MAX_HW}" height="38"
        rx="6" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="${SVG_CX - 52}" y="26" text-anchor="end"
        font-family="Barlow,sans-serif" font-size="10" font-weight="700"
        letter-spacing="1" fill="#6B7A99">TOTAL DE LEADS NO PERÍODO</text>
  <text x="${SVG_CX - 46}" y="30" text-anchor="start"
        font-family="Barlow Condensed,sans-serif" font-size="22" font-weight="700"
        fill="#0D234A">${N(totalLeads)}</text>
  <text x="${SVG_CX + 2}" y="26" text-anchor="start"
        font-family="Barlow,sans-serif" font-size="10" fill="#94A3B8"> entradas no funil</text>`;

  const svgContent = funnelStages.map((fs, i) => {
    const topHW = MAX_HW - i * STEP;
    const botHW = MAX_HW - (i + 1) * STEP;
    const y0    = HEADER_H + i * ROW_H;
    const midY  = y0 + SLICE_H / 2;

    const pts = `${SVG_CX - topHW},${y0} ${SVG_CX + topHW},${y0} ${SVG_CX + botHW},${y0 + SLICE_H} ${SVG_CX - botHW},${y0 + SLICE_H}`;

    // Conversão acumulada e etapa-a-etapa
    const prevCumCount = i > 0 ? funnelStages[i - 1].cumCount : null;
    const convCum  = i === 0 ? null
                   : (totalLeads > 0 ? ((fs.cumCount / totalLeads) * 100).toFixed(1) + "%" : "—");
    const convPrev = i === 0 ? null
                   : (prevCumCount > 0 ? ((fs.cumCount / prevCumCount) * 100).toFixed(1) + "%" : "0%");

    const nameY  = midY - 22;
    const countY = midY + 4;
    const line1Y = midY + 19;
    const line2Y = midY + 31;

    const nameFill  = fs.isGanho ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.55)";
    const pct1Fill  = fs.isGanho ? "rgba(255,255,255,0.9)"  : "rgba(255,255,255,0.75)";
    const pct2Fill  = fs.isGanho ? "rgba(255,255,255,0.6)"  : "rgba(255,255,255,0.42)";

    let percentText;
    if (i === 0) {
      percentText = `<text x="${SVG_CX}" y="${line1Y}" text-anchor="middle" font-family="Barlow,sans-serif" font-size="9.5" fill="rgba(255,255,255,0.4)">100% — entrada do funil</text>`;
    } else {
      percentText = `<text x="${SVG_CX}" y="${line1Y}" text-anchor="middle" font-family="Barlow,sans-serif" font-size="10" font-weight="600" fill="${pct1Fill}">↓ ${convPrev} da etapa ant. · ${convCum} do total</text>`;
    }

    // Label de valor na área branca à direita do trapézio
    const rightMid = SVG_CX + (topHW + botHW) / 2;
    const valStr   = C(fs.value);
    const valLabel = `
  <line x1="${rightMid + 6}" y1="${midY}" x2="578" y2="${midY}" stroke="#CBD5E1" stroke-width="1" stroke-dasharray="3,3"/>
  <text x="582" y="${midY - 5}" font-family="Barlow Condensed,sans-serif" font-size="13" font-weight="700" fill="#0D234A">${valStr}</text>
  <text x="582" y="${midY + 9}" font-family="Barlow,sans-serif" font-size="9" fill="#94A3B8">${fs.isGanho ? "ganho" : "em aberto"}</text>`;

    return `<g onclick="openStageModal(${i})" style="cursor:pointer" class="funnel-slice">
  <polygon points="${pts}" fill="${COLORS[i]}"/>
  <text x="${SVG_CX}" y="${nameY}" text-anchor="middle" font-family="Barlow Condensed,sans-serif" font-size="10" font-weight="600" letter-spacing="2" fill="${nameFill}">${fs.name.toUpperCase()}</text>
  <text x="${SVG_CX}" y="${countY}" text-anchor="middle" font-family="Barlow Condensed,sans-serif" font-size="26" font-weight="700" fill="white">${N(fs.count)}</text>
  ${percentText}
  ${valLabel}
</g>`;
  }).join("\n  ");

  // ── Breakdown ─────────────────────────────────────────────────────────────────
  const mkBreak = (field, cls) =>
    stages.filter(s => s[field] > 0)
      .map(s => `<div class="brow"><span>${s.name}</span><span class="bn ${cls}">${N(s[field])}</span></div>`)
      .join("") || `<div class="bempty">Nenhum</div>`;

  const totalLost = totals.lost || 1;
  const mkLostReasons = () => {
    const sorted = Object.entries(lostReasons).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return `<div class="bempty">Nenhum</div>`;
    return sorted.map(([reason, count]) => {
      const pct = ((count / totalLost) * 100).toFixed(1);
      return `<div class="brow">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${reason}">${reason}</span>
        <span style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <span class="bn lost">${N(count)}</span>
          <span style="font-size:10px;color:#94A3B8;min-width:36px;text-align:right">${pct}%</span>
        </span>
      </div>`;
    }).join("");
  };

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard MCMV · Avantor Imóveis</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Barlow',sans-serif;background:#EEF1F7;color:#0D234A;font-size:14px;min-height:100vh}

/* ── Header ──────────────────────────────────────── */
.hdr{background:#0D234A;height:72px;display:flex;align-items:center;
     justify-content:space-between;padding:0 28px;
     box-shadow:0 2px 12px rgba(0,0,0,.25)}
.hdr-l{display:flex;align-items:center}
.logo-img{height:50px;width:auto;display:block}
.hdr-r{display:flex;align-items:center;gap:16px}
.hdr-pipe{font-size:11px;color:rgba(255,255,255,.35);letter-spacing:.04em}
.live{display:flex;align-items:center;gap:5px;background:rgba(22,163,74,.15);
      border:1px solid rgba(22,163,74,.3);border-radius:20px;padding:4px 11px;
      font-size:11px;color:#4ADE80}
.dot{width:6px;height:6px;background:#4ADE80;border-radius:50%;
     animation:p 1.8s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.65)}}
.hdr-ts{font-size:10.5px;color:rgba(255,255,255,.3)}
.gold-bar{height:3px;background:#E6B012}

/* ── Wrap ────────────────────────────────────────── */
.wrap{max-width:1180px;margin:0 auto;padding:22px 28px}

/* ── Filter ──────────────────────────────────────── */
.filter{background:#fff;border:1px solid #E2E8F0;border-radius:10px;
        padding:12px 18px;display:flex;align-items:center;gap:10px;
        flex-wrap:wrap;margin-bottom:18px}
.flbl{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
      letter-spacing:.07em;flex-shrink:0}
.qbtns{display:flex;gap:5px;flex-wrap:wrap}
.qb{background:none;border:1px solid #E2E8F0;border-radius:6px;padding:4px 11px;
    font-size:12px;font-family:'Barlow',sans-serif;color:#0D234A;cursor:pointer;transition:all .15s}
.qb:hover,.qb.on{background:#0D234A;color:#fff;border-color:#0D234A}
.fsep{width:1px;height:26px;background:#E2E8F0;flex-shrink:0}
.dinp{display:flex;align-items:center;gap:7px}
.dinp input[type=date]{border:1px solid #E2E8F0;border-radius:6px;padding:4px 9px;
    font-size:12px;font-family:'Barlow',sans-serif;color:#0D234A;outline:none}
.dinp input[type=date]:focus{border-color:#0D234A}
.dsep{font-size:12px;color:#6B7A99}
.fapply{background:#E6B012;border:none;border-radius:6px;padding:5px 14px;
        font-size:12px;font-weight:700;font-family:'Barlow',sans-serif;
        color:#0D234A;cursor:pointer;transition:opacity .15s}
.fapply:hover{opacity:.85}
.period-tag{margin-left:auto;background:rgba(230,176,18,.1);
            border:1px solid rgba(230,176,18,.3);border-radius:6px;
            padding:3px 11px;font-size:10.5px;color:#8B6508;font-weight:500}

/* ── KPI grid ────────────────────────────────────── */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid #E2E8F0;border-radius:10px;
     padding:18px 20px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px}
.kpi.k-navy::after{background:#0D234A}
.kpi.k-gold::after{background:#E6B012}
.kpi.k-green::after{background:#16A34A}
.kpi.k-red::after{background:#DC2626}
.klbl{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
      letter-spacing:.07em;margin-bottom:9px}
.kval{font-size:34px;font-weight:700;line-height:1;color:#0D234A;
      font-family:'Barlow Condensed',sans-serif;letter-spacing:-.01em}
.kpi.k-green .kval{color:#16A34A}
.kpi.k-red .kval{color:#DC2626}
.ksub{font-size:11px;color:#6B7A99;margin-top:5px}

/* ── Section ─────────────────────────────────────── */
.section{background:#fff;border:1px solid #E2E8F0;border-radius:10px;
         padding:22px 24px;margin-bottom:18px}
.sec-title{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
           letter-spacing:.1em;margin-bottom:22px;display:flex;align-items:center;gap:10px}
.sec-title::after{content:'';flex:1;height:1px;background:#E2E8F0}

/* ── Funil SVG ───────────────────────────────────── */
.funnel-total{display:flex;align-items:center;justify-content:center;gap:10px;
              margin-bottom:14px;padding:9px 20px;background:#F1F5F9;
              border-radius:8px;border:1px dashed #CBD5E1}
.ft-label{font-size:11px;color:#6B7A99;font-weight:600;text-transform:uppercase;letter-spacing:.07em}
.ft-val{font-family:'Barlow Condensed',sans-serif;font-size:24px;font-weight:700;color:#0D234A;line-height:1}
.ft-sub{font-size:11px;color:#94A3B8}
.funnel-wrap{display:flex;justify-content:center;overflow-x:auto}
.funnel-wrap svg{height:auto;transition:width .2s ease}
.zoom-btns{display:flex;gap:6px;margin-left:auto}
.zbtn{background:none;border:1px solid #E2E8F0;border-radius:6px;
      padding:3px 10px;font-size:13px;color:#0D234A;cursor:pointer;
      font-family:'Barlow',sans-serif;transition:all .15s}
.zbtn:hover{background:#0D234A;color:#fff;border-color:#0D234A}

/* ── Breakdown ───────────────────────────────────── */
.bg3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
.bc{background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px 18px}
.bt{font-size:10px;font-weight:700;color:#6B7A99;text-transform:uppercase;
    letter-spacing:.08em;margin-bottom:10px}
.brow{display:flex;justify-content:space-between;align-items:center;
      padding:5px 0;border-bottom:1px solid #F1F5F9;font-size:12px}
.brow:last-child{border-bottom:none}
.bn{font-weight:700;font-family:'Barlow Condensed',sans-serif;font-size:15px}
.bn.open{color:#2563EB}.bn.won{color:#16A34A}.bn.lost{color:#6B7A99}
.bempty{font-size:12px;color:#CBD5E1}

/* ── Modal ───────────────────────────────────────── */
.modal-overlay{position:fixed;inset:0;background:rgba(13,35,74,.65);z-index:999;
               display:flex;align-items:center;justify-content:center;padding:20px}
.modal-card{background:#fff;border-radius:12px;width:100%;max-width:740px;
            max-height:82vh;display:flex;flex-direction:column;
            box-shadow:0 20px 60px rgba(0,0,0,.35)}
.modal-hdr{display:flex;align-items:center;gap:12px;padding:18px 22px;
           border-bottom:2px solid #E2E8F0;flex-shrink:0}
.modal-title{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;
             color:#0D234A;flex:1;letter-spacing:.01em}
.modal-cnt{font-size:12px;color:#6B7A99;flex-shrink:0}
.modal-close{background:none;border:1px solid #E2E8F0;border-radius:6px;
             padding:4px 11px;font-size:16px;cursor:pointer;color:#6B7A99;
             line-height:1;transition:all .15s}
.modal-close:hover{background:#0D234A;color:#fff;border-color:#0D234A}
.modal-body{overflow-y:auto;flex:1}
.modal-table{width:100%;border-collapse:collapse;font-size:13px}
.modal-table th{text-align:left;font-size:10px;font-weight:700;color:#6B7A99;
                text-transform:uppercase;letter-spacing:.08em;padding:9px 14px;
                border-bottom:2px solid #E2E8F0;background:#F8FAFC;position:sticky;top:0}
.modal-table td{padding:9px 14px;border-bottom:1px solid #F1F5F9;color:#0D234A;vertical-align:middle}
.modal-table tr:last-child td{border-bottom:none}
.modal-table tr:hover td{background:#F8FAFC}
.modal-val{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;color:#0D234A}
.modal-st{display:inline-block;padding:2px 8px;border-radius:4px;
          font-size:10px;font-weight:700;text-transform:uppercase}
.modal-st.open{background:rgba(37,99,235,.1);color:#2563EB}
.modal-st.won{background:rgba(22,163,74,.1);color:#16A34A}
.modal-st.lost{background:rgba(220,38,38,.1);color:#DC2626}
.modal-empty{padding:40px;text-align:center;color:#94A3B8;font-size:13px}
.funnel-slice:hover polygon{opacity:.85}
.funnel-slice polygon{transition:opacity .15s}

/* ── Footer ──────────────────────────────────────── */
.foot{display:flex;justify-content:space-between;align-items:center;
      padding:10px 0;border-top:1px solid #E2E8F0;
      font-size:10px;color:#94A3B8;letter-spacing:.03em}

/* ── Responsive ──────────────────────────────────── */
@media(max-width:768px){
  .wrap{padding:14px}
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .bg3{grid-template-columns:1fr}
  .hdr{padding:0 14px}
  .hdr-pipe,.hdr-ts{display:none}
}
</style>
</head>
<body>

<!-- Header -->
<header class="hdr">
  <div class="hdr-l">
    <img src="/logo.png" alt="Avantor Imóveis" class="logo-img">
  </div>
  <div class="hdr-r">
    <span class="hdr-pipe">Pipeline MCMV</span>
    <div class="live"><div class="dot"></div>Tempo real</div>
    <span class="hdr-ts">${fmt(updatedAt)}</span>
  </div>
</header>
<div class="gold-bar"></div>

<div class="wrap">

  <!-- Filtro de período -->
  <div class="filter">
    <span class="flbl">Período</span>
    <div class="qbtns">
      <button ${qb("todos")} onclick="clearF()">Todos</button>
      <button ${qb("hoje")} onclick="setD(0)">Hoje</button>
      <button ${qb("7d")}   onclick="setD(7)">7 dias</button>
      <button ${qb("30d")}  onclick="setD(30)">30 dias</button>
      <button ${qb("90d")}  onclick="setD(90)">90 dias</button>
      <button ${qb("mes")}  onclick="setMes()">Este mês</button>
    </div>
    <div class="fsep"></div>
    <form class="dinp" method="get" action="/">
      <input type="date" name="from" value="${from}">
      <span class="dsep">→</span>
      <input type="date" name="to" value="${to}">
      <button type="submit" class="fapply">Filtrar</button>
    </form>
    <span class="period-tag">${periodLabel}</span>
  </div>

  <!-- KPIs -->
  <div class="kpi-grid">
    <div class="kpi k-navy">
      <div class="klbl">Total no pipeline</div>
      <div class="kval">${N(totals.total)}</div>
      <div class="ksub">oportunidades</div>
    </div>
    <div class="kpi k-navy">
      <div class="klbl">Em aberto</div>
      <div class="kval">${N(totals.open)}</div>
      <div class="ksub">ativos no funil</div>
    </div>
    <div class="kpi k-green">
      <div class="klbl">Ganhos</div>
      <div class="kval">${N(totals.won)}</div>
      <div class="ksub">${C(totals.won_val)} em valor</div>
    </div>
    <div class="kpi k-red">
      <div class="klbl">Perdidos</div>
      <div class="kval">${N(totals.lost)}</div>
      <div class="ksub">conv. geral ${P(totals.won, totals.total)}</div>
    </div>
  </div>

  <!-- Funil SVG -->
  <div class="section">
    <div class="sec-title">Funil de vendas — por etapa
      <div class="zoom-btns">
        <button class="zbtn" onclick="funnelZoom(-1)" title="Diminuir">−</button>
        <button class="zbtn" onclick="funnelZoom(0)"  title="Resetar">↺</button>
        <button class="zbtn" onclick="funnelZoom(1)"  title="Aumentar">+</button>
      </div>
    </div>
    <div class="funnel-wrap">
      <svg id="funnel-svg" viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" xmlns="http://www.w3.org/2000/svg">
        ${svgHeader}
        ${svgContent}
      </svg>
    </div>
  </div>

  <!-- Breakdown -->
  <div class="bg3">
    <div class="bc">
      <div class="bt">Em aberto por etapa</div>
      ${mkBreak("open", "open")}
    </div>
    <div class="bc">
      <div class="bt">Ganhos por etapa</div>
      ${mkBreak("won", "won")}
    </div>
    <div class="bc">
      <div class="bt">Perdidos por etapa</div>
      ${mkBreak("lost", "lost")}
    </div>
  </div>
  <div class="bc" style="margin-bottom:18px">
    <div class="bt">Perdidos por motivo</div>
    ${mkLostReasons()}
  </div>

  <!-- Modal de clientes por etapa -->
  <div id="stage-modal" class="modal-overlay" style="display:none" onclick="closeModalBg(event)">
    <div class="modal-card">
      <div class="modal-hdr">
        <div class="modal-title" id="modal-title">—</div>
        <div class="modal-cnt" id="modal-cnt"></div>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <!-- Footer -->
  <div class="foot">
    <span>Avantor Imóveis · Dashboard MCMV · Cache ${CACHE_TTL / 1000}s</span>
    <span>Atualizado em ${fmt(updatedAt)}</span>
  </div>

</div>

<script>
const brDate = n => new Date(n).toLocaleDateString("sv", {timeZone: "America/Sao_Paulo"});
const nav    = (f, t) => location.href = '/?from=' + f + '&to=' + t;

function clearF() { location.href = '/'; }

function setD(days) {
  const today = brDate(Date.now());
  const from  = days === 0 ? today : brDate(Date.now() - days * 86400000);
  nav(from, today);
}

function setMes() {
  const today = brDate(Date.now());
  nav(today.slice(0, 8) + '01', today);
}

setTimeout(() => location.reload(), ${CACHE_TTL});

const stageData = ${stageDataJSON};

const statusLabel = { open: "Aberto", won: "Ganho", lost: "Perdido" };
const fmtVal = v => v ? "R$ " + v.toLocaleString("pt-BR") : "—";
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";

function openStageModal(idx) {
  const sd = stageData[idx];
  document.getElementById("modal-title").textContent = sd.name;
  document.getElementById("modal-cnt").textContent = sd.clients.length + " cliente(s) nesta etapa";
  const body = document.getElementById("modal-body");
  if (!sd.clients.length) {
    body.innerHTML = '<div class="modal-empty">Nenhum cliente registrado nesta etapa.</div>';
  } else {
    const rows = sd.clients.map(c => \`
      <tr>
        <td>\${c.name}</td>
        <td>\${c.phone}</td>
        <td style="color:#6B7A99;font-size:12px">\${c.email}</td>
        <td class="modal-val">\${fmtVal(c.value)}</td>
        <td style="color:#6B7A99;font-size:12px">\${fmtDate(c.createdAt)}</td>
        <td><span class="modal-st \${c.status}">\${statusLabel[c.status] || c.status}</span></td>
      </tr>\`).join("");
    body.innerHTML = \`<table class="modal-table">
      <thead><tr>
        <th>Nome</th><th>Telefone</th><th>E-mail</th>
        <th>Valor</th><th>Criado em</th><th>Status</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  }
  document.getElementById("stage-modal").style.display = "flex";
}

function closeModal() {
  document.getElementById("stage-modal").style.display = "none";
}

function closeModalBg(e) {
  if (e.target === document.getElementById("stage-modal")) closeModal();
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

const BASE_W = ${SVG_W};
let zoomLevel = 0;
function funnelZoom(dir) {
  const svg = document.getElementById('funnel-svg');
  if (dir === 0) { zoomLevel = 0; }
  else { zoomLevel = Math.max(-4, Math.min(6, zoomLevel + dir)); }
  svg.style.width = (BASE_W + zoomLevel * 80) + 'px';
}
</script>

</body>
</html>`;

  res.send(html);
});

app.listen(PORT, () => console.log(`Dashboard MCMV na porta ${PORT}`));
