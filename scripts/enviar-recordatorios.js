// ══════════════════════════════════════════════════════════════════════════
// Recordatorios de Quiniela Apertura 2026 — GitHub Actions
//
// Corre cada 15 minutos. Lee el fixture directo del index.html YA PUBLICADO
// en Netlify (una sola fuente de verdad, no se duplica el fixture aquí).
// Para cada Jornada (1-17) y cada fase de Liguilla (Cuartos/Semis/Final),
// busca el PRIMER partido por fecha+hora.
//
// Recordatorios: SOLO 2 avisos por jornada/fase, uno "de 90" y otro "de 60"
// minutos antes de ese kickoff. Como el cron de GitHub puede llegar con
// retraso, cada aviso tiene un rango de alcance:
//   - aviso de 90: se envía si faltan entre 75 y 90 minutos
//   - aviso de 60: se envía si faltan entre 45 y 60 minutos
// (el bloqueo de predicciones del index.html ocurre a los 30 min, así que
// no se notifica después). Cada aviso queda marcado por separado en
// notificado/{key}/{90|60} para no duplicarse entre corridas del cron.
//
// Texto del push (igual para todos, hayan pronosticado o no):
//   Título: "Jornada {N}: ¡haz tus pronósticos!"
//           (Liguilla: "Partido de Ida: …" / "Partido de Vuelta: …")
//   Cuerpo: "El primer partido cierra el {día} {número} a las {HH:mm} (hora CDMX)."
// La hora que se muestra es el CIERRE de predicciones (kickoff − 30 min),
// calculado en hora CDMX (UTC-6, sin horario de verano), igual que esCerrado()
// en el index.html. A todos los suscriptores se les envía el aviso: ya no se
// omite a quien ya pronosticó.
//
// Liguilla: cada fase se divide en IDA y VUELTA (ids pares = ida, impares =
// vuelta, según CUARTOS_SERIES / SEMIS_META / FINAL_META del index.html) y,
// dentro de cada una, en un grupo POR DÍA de partidos. Cada día avisa por
// separado (90 y 60 min) con el primer partido de ESE día.
// FECHA_LIGUILLA hoy son textos como "Por definir" o "2026-11-25 (o 26)"
// (no una hora exacta) — mientras no tengan el formato estricto
// "YYYY-MM-DD HH:MM", ese grupo simplemente se salta (no es un error).
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

const VENTANA_MIN_MINUTOS = 45; // límite inferior: fin del alcance del aviso de 60
const VENTANA_MAX_MINUTOS = 90; // límite superior: 1.5 horas antes del primer partido
// Rangos de alcance por aviso: { slot, desde (excluyente), hasta (incluyente) } en minutos restantes.
const RANGOS_AVISO = [
  { slot: 90, desde: 75, hasta: 90 },
  { slot: 60, desde: 45, hasta: 60 },
];

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

  // Cada fase se separa en IDA y VUELTA (ver CUARTOS_SERIES / SEMIS_META /
  // FINAL_META en el index.html: idaId pares, vueltaId impares) y, además,
  // en un grupo POR DÍA de partidos (fecha CDMX): cada día de Liguilla tiene
  // su propio par de avisos, calculado con el primer partido de ese día.
  const fasesLiguilla = [
    { key: "liguilla_cuartos_ida", label: "Partido de Ida", ids: [154, 156, 158, 160] },
    { key: "liguilla_cuartos_vuelta", label: "Partido de Vuelta", ids: [155, 157, 159, 161] },
    { key: "liguilla_semis_ida", label: "Partido de Ida", ids: [162, 164] },
    { key: "liguilla_semis_vuelta", label: "Partido de Vuelta", ids: [163, 165] },
    { key: "liguilla_final_ida", label: "Partido de Ida", ids: [166] },
    { key: "liguilla_final_vuelta", label: "Partido de Vuelta", ids: [167] },
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

    // Un grupo por fecha. La fecha entra en la clave de control de duplicados
    // (notificado/{key}/{slot}), así cada día se marca por separado.
    const porFecha = {};
    for (const p of partidos) (porFecha[p.fecha] = porFecha[p.fecha] || []).push(p);
    for (const [fecha, delDia] of Object.entries(porFecha)) {
      groups.push({ key: `${fase.key}_${fecha}`, label: fase.label, partidos: delDia });
    }
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

// Devuelve 90 o 60 según el rango de alcance en el que caigan los minutos
// restantes, o null si no corresponde avisar en este momento.
function slotPara(minutosPara) {
  for (const r of RANGOS_AVISO) {
    if (minutosPara > r.desde && minutosPara <= r.hasta) return r.slot;
  }
  return null;
}

const DIAS_SEMANA = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MINUTOS_CIERRE_ANTES = 30; // mismo criterio que esCerrado() en el index.html

// Cierre de predicciones = kickoff − 30 min, expresado en hora CDMX (UTC-6).
// Se desplaza el instante −6 h y se leen los campos UTC, así el resultado no
// depende de la zona horaria del servidor.
function textoCierre(kickoffTs) {
  const cierreCDMX = new Date(kickoffTs - MINUTOS_CIERRE_ANTES * 60000 - 6 * 3600000);
  const dia = DIAS_SEMANA[cierreCDMX.getUTCDay()];
  const num = cierreCDMX.getUTCDate();
  const hh = String(cierreCDMX.getUTCHours()).padStart(2, "0");
  const mm = String(cierreCDMX.getUTCMinutes()).padStart(2, "0");
  return `${dia} ${num} a las ${hh}:${mm} (hora CDMX)`;
}

// `tag` único por grupo+aviso: si dos avisos compartieran tag, el segundo
// REEMPLAZARÍA al primero y Android no volvería a sonar. Con tags distintos
// cada aviso (90 y 60 min, y cada día de Liguilla) es una notificación aparte
// y alerta normalmente. sw.js ya usa data.tag tal cual, sin cambios allá.
async function enviarASubscriptores(subs, label, kickoffTs, minutosReales, tag) {
  const payload = JSON.stringify({
    title: `${label}: ¡haz tus pronósticos!`,
    body: `El primer partido cierra el ${textoCierre(kickoffTs)}.`,
    tag,
  });

  const entries = Object.entries(subs);
  console.log(`Enviando a ${entries.length} suscripción(es) para: ${label} (faltan ~${minutosReales} min al kickoff)`);

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

    const slot = slotPara(minutosPara);
    if (slot === null) continue;

    gruposEnVentana.push({ group, primero, slot, minutosPara });
  }

  if (gruposEnVentana.length === 0) {
    console.log("Ningún grupo cae en un corte de aviso en este ciclo.");
    return;
  }

  // Sólo pedimos las suscripciones si de verdad hay algo que enviar, y las
  // pedimos una sola vez para todos los grupos de este ciclo.
  const subsTodas = await fbGet("pushSubs").then((v) => v || {});

  for (const { group, primero, slot, minutosPara } of gruposEnVentana) {
    const yaNotificado = await fbGet(`notificado/${group.key}/${slot}`).catch(() => null);
    if (yaNotificado) continue;

    // Se envía a TODOS los suscritos, hayan pronosticado o no.
    if (Object.keys(subsTodas).length > 0) {
      await enviarASubscriptores(
        subsTodas,
        group.label,
        primero.ts,
        Math.round(minutosPara),
        `quiniela-${group.key}-${slot}`
      );
    }

    await fbSet(`notificado/${group.key}/${slot}`, true);
    console.log(`✓ Notificado (aviso de ${slot} min, faltaban ~${Math.round(minutosPara)}): ${group.label}`);
  }
}

main().catch((err) => {
  console.error("Error en el script de recordatorios:", err);
  process.exit(1);
});
