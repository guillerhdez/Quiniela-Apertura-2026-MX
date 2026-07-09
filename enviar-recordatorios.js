// ══════════════════════════════════════════════════════════════════════════
// Recordatorios de Quiniela Apertura 2026 — GitHub Actions
//
// Corre cada 15 minutos. Lee el fixture directo del index.html YA PUBLICADO
// en Netlify (una sola fuente de verdad, no se duplica el fixture aquí).
// Para cada Jornada (1-17) y cada fase de Liguilla (Cuartos/Semis/Final),
// busca el PRIMER partido por fecha+hora. Si faltan entre 45 y 75 minutos
// para ese kickoff, y no se ha notificado ya esa jornada/fase, manda un
// push a todas las suscripciones guardadas en Firebase.
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

// ⚠️ Nota: el "subject" de VAPID debe ser un mailto: o https: real donde te
// puedan contactar los proveedores de push (Google/Apple/Mozilla) si hay un
// problema con el envío. Puse un placeholder — reemplázalo por un correo
// real tuyo cuando puedas (no es sensible, no hace falta que sea secreto).
webpush.setVapidDetails(
  "mailto:admin@quiniela-apertura-2026-mx.example",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const VENTANA_MIN_MINUTOS = 45;
const VENTANA_MAX_MINUTOS = 75;

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

// Mismo criterio que el frontend (esCerrado): CDMX = UTC-6, sin horario de verano.
function kickoffUTCms(fecha, hora) {
  const [h, m] = hora.split(":").map(Number);
  return Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1, +fecha.slice(8, 10), h + 6, m, 0);
}

function buildGroups(PG_LIGAMX, FECHA_LIGUILLA) {
  const groups = [];

  for (let n = 1; n <= 17; n++) {
    const partidos = PG_LIGAMX.filter((p) => p.jornada === n).map((p) => ({
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
      .map((id) => FECHA_LIGUILLA[id])
      .filter(Boolean)
      .map((raw) => {
        const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(String(raw).trim());
        return m ? { fecha: m[1], hora: m[2] } : null;
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

async function enviarATodos(label) {
  const subs = (await fbGet("pushSubs")) || {};
  const payload = JSON.stringify({
    title: "Quiniela Apertura 2026",
    body: `⚽ Recordatorio: ${label} empieza en 1 hora. No olvides meter tus predicciones.`,
    tag: "quiniela-recordatorio",
  });

  const entries = Object.entries(subs);
  console.log(`Enviando a ${entries.length} suscripción(es) para: ${label}`);

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

  for (const group of groups) {
    const primero = primerKickoff(group.partidos);
    if (!primero) continue; // sin horario confirmado todavía (ej. Liguilla "Por definir")

    const minutosPara = (primero.ts - now) / 60000;
    if (minutosPara < VENTANA_MIN_MINUTOS || minutosPara > VENTANA_MAX_MINUTOS) continue;

    const yaNotificado = await fbGet(`notificado/${group.key}`).catch(() => null);
    if (yaNotificado) continue;

    await enviarATodos(group.label);
    await fbSet(`notificado/${group.key}`, true);
    console.log(`✓ Notificado: ${group.label}`);
  }
}

main().catch((err) => {
  console.error("Error en el script de recordatorios:", err);
  process.exit(1);
});
