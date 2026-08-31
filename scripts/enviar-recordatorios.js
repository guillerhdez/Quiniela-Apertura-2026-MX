// ══════════════════════════════════════════════════════════════════════════
// Recordatorios de Quiniela Apertura 2026 — GitHub Actions
//
// Corre cada 15 minutos. Lee el fixture directo del index.html YA PUBLICADO
// en Netlify (una sola fuente de verdad, no se duplica el fixture aquí).
// Para cada Jornada (1-17) y cada fase de Liguilla (Cuartos/Semis/Final),
// busca el PRIMER partido por fecha+hora.
//
// Ventana de recordatorios: entre 90 y 30 minutos antes de ese kickoff
// (el bloqueo de predicciones del index.html ocurre a los 30 min, así que
// no tiene caso notificar después de eso). Dentro de esa ventana se manda
// UN aviso por cada corte de 15 min (90, 75, 60, 45, 30 → hasta 5 avisos
// por jornada/fase), cada uno marcado por separado en
// notificado/{key}/{slot} para no duplicarse entre corridas del cron.
//
// Antes de cada envío se filtran los suscriptores que YA tengan guardada
// una predicción válida para el primer partido de esa jornada/fase — a
// ellos se les omite el push (ya no lo necesitan), sin afectar al resto.
//
// Liguilla: FECHA_LIGUILLA hoy son textos como "Por definir" o "25-26 nov"
// (no una hora exacta) — mientras no tengan el formato estricto
// "YYYY-MM-DD HH:MM", esa fase simplemente se salta (no es un error).
// ══════════════════════════════════════════════════════════════════════════

const webpush = require("web-push");

const NETLIFY_URL = "https://quiniela-apertura-2026-mx.netlify.app";
const FB = "https://quiniela-apertura-2026-lmx-default-rtdb.firebaseio.com";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  "mailto:admin@quiniela-apertura-2026-mx.example",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const VENTANA_MIN_MINUTOS = 30; // límite inferior: coincide con el bloqueo de predicciones
const VENTANA_MAX_MINUTOS = 90; // límite superior: 1.5 horas antes del primer partido
const SLOTS = [90, 75, 60, 45, 30]; // cortes de aviso dentro de la ventana
const TOLERANCIA_MIN = 7; // margen para que un cron con leve retraso siga cayendo en su slot

async function fbGet(path) {
  const res = await fetch(`${FB}/${path}.json`);
  if (!res.ok) throw new Error(`fbGet(${path}) falló: ${res.status}`);
  return res.json();
}

async function fbSet(path, value) {
  const res = await fetch(`${FB}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`fbSet(${path}) falló: ${res.status}`);
  return res.json();
}

async function fetchFixture() {
  const res = await fetch(NETLIFY_URL);
  if (!res.ok) throw new Error(`No se pudo descargar el index.html: ${res.status}`);
  const html = await res.text();

  const pgMatch = html.match(/const PG_LIGAMX\s*=\s*(\[[\s\S]*?\]);/);
  if (!pgMatch) throw new Error("No se encontró PG_LIGAMX en el HTML publicado");
  const PG_LIGAMX = new Function(`"use strict"; return (${pgMatch[1]});`)();

  const flMatch = html.match(/const FECHA_LIGUILLA\s*=\s*(\{[\s\S]*?\});/);
  const FECHA_LIGUILLA = flMatch ? new Function(`"use strict"; return (${flMatch[1]});`)() : {};

  return { PG_LIGAMX, FECHA_LIGUILLA };
}

function kickoffUTCms(fecha, hora) {
  const [h, m] = hora.split(":").map(Number);
  return Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1, +fecha.slice(8, 10), h + 6, m, 0);
}

function buildGroups(PG_LIGAMX, FECHA_LIGUILLA) {
  const groups = [];

  for (let n = 1; n <= 17; n++) {
    const partidos = PG_LIGAMX.filter((p) => p.jornada === n).map((p) => ({
      id: p.id,
      fecha: p.fecha,
      hora: p.hora,
    }));
    groups.push({ key: `jornada_${n}`, label: `Jornada ${n}`, partidos });
  }

  const fasesLiguilla = [
    { key: "liguilla_cuartos", label: "Cuartos de Final", ids: [154, 155, 156, 157, 158, 159, 160, 161] },
    { key: "liguilla_semis", label: "Semifinal", ids: [162, 163, 164, 165] },
    { key: "liguilla_final", label: "Final", ids: [166, 167] },
  ];

  for (const fase of fasesLiguilla) {
    const partidos = fase.ids
      .map((id) => ({ id, raw: FECHA_LIGUILLA[id] }))
      .filter((x) => x.raw)
      .map(({ id, raw }) => {
        const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(String(raw).trim());
        return m ? { id, fecha: m[1], hora: m[2] } : null;
      })
      .filter(Boolean);
    groups.push({ key: fase.key, label: fase.label, partidos });
  }

  return groups;
}

function primerKickoff(partidos) {
  const validos = partidos
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.fecha) && /^\d{2}:\d{2}$/.test(p.hora))
    .map((p) => ({ ...p, ts: kickoffUTCms(p.fecha, p.hora) }))
    .sort((a, b) => a.ts - b.ts);
  return validos[0] || null;
}

// Redondea los minutos restantes al corte de 15 más cercano y sólo lo
// acepta si cae dentro de SLOTS y dentro de la tolerancia — así un cron
// con unos minutos de retraso sigue detectando el corte correcto.
function slotMasCercano(minutosPara) {
  const redondeado = Math.round(minutosPara / 15) * 15;
  if (!SLOTS.includes(redondeado)) return null;
  if (Math.abs(minutosPara - redondeado) > TOLERANCIA_MIN) return null;
  return redondeado;
}

function yaPredijo(predicciones, uid, matchId) {
  const pred = (predicciones[uid] || {})[matchId];
  return !!pred && pred.gl !== "" && pred.gv !== "" && pred.gl != null && pred.gv != null;
}

async function enviarASubscriptores(subs, label, slot) {
  const payload = JSON.stringify({
    title: "Quiniela Apertura 2026",
    body: `⚽ Recordatorio: ${label} empieza en ${slot} minutos. No olvides meter tus predicciones.`,
    tag: "quiniela-recordatorio",
  });

  const entries = Object.entries(subs);
  console.log(`Enviando a ${entries.length} suscripción(es) para: ${label} (faltan ${slot} min)`);

  for (const [uid, sub] of entries) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        console.log(`Suscripción caducada de ${uid}, eliminando...`);
        await fbSet(`pushSubs/${uid}`, null).catch(() => {});
      } else {
        console.error(`Error enviando a ${uid}:`, status || err.message);
      }
    }
  }
}

async function main() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY como variables de entorno");
  }

  const { PG_LIGAMX, FECHA_LIGUILLA } = await fetchFixture();
  const groups = buildGroups(PG_LIGAMX, FECHA_LIGUILLA);
  const now = Date.now();

  // Primero determinamos qué grupos caen en un slot válido de la ventana,
  // sin tocar Firebase todavía.
  const gruposEnVentana = [];
  for (const group of groups) {
    const primero = primerKickoff(group.partidos);
    if (!primero) continue;

    const minutosPara = (primero.ts - now) / 60000;
    if (minutosPara < VENTANA_MIN_MINUTOS || minutosPara > VENTANA_MAX_MINUTOS) continue;

    const slot = slotMasCercano(minutosPara);
    if (slot === null) continue;

    gruposEnVentana.push({ group, primero, slot });
  }

  if (gruposEnVentana.length === 0) {
    console.log("Ningún grupo cae en un corte de aviso en este ciclo.");
    return;
  }

  // Sólo pedimos subs y predicciones si de verdad hay algo que evaluar,
  // y las pedimos una sola vez para todos los grupos de este ciclo.
  const [subsTodas, predicciones] = await Promise.all([
    fbGet("pushSubs").then((v) => v || {}),
    fbGet("predicciones").then((v) => v || {}),
  ]);

  for (const { group, primero, slot } of gruposEnVentana) {
    const yaNotificado = await fbGet(`notificado/${group.key}/${slot}`).catch(() => null);
    if (yaNotificado) continue;

    const subsAEnviar = Object.fromEntries(
      Object.entries(subsTodas).filter(([uid]) => !yaPredijo(predicciones, uid, primero.id))
    );
    const omitidos = Object.keys(subsTodas).length - Object.keys(subsAEnviar).length;
    if (omitidos > 0) {
      console.log(`${omitidos} suscriptor(es) omitido(s) por ya tener predicción de ${group.label}`);
    }

    if (Object.keys(subsAEnviar).length > 0) {
      await enviarASubscriptores(subsAEnviar, group.label, slot);
    }

    await fbSet(`notificado/${group.key}/${slot}`, true);
    console.log(`✓ Notificado (slot ${slot} min): ${group.label}`);
  }
}

main().catch((err) => {
  console.error("Error en el script de recordatorios:", err);
  process.exit(1);
});
