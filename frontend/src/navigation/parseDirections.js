// -----------------------------------------------------------------------------
// parseDirections.js — Valhalla maneuver parsing and display helpers.
// -----------------------------------------------------------------------------

export function formatDuration(sec) {
  const totalMin = Math.max(1, Math.round(sec / 60));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push({ value: days, unit: "d" });
  if (hours) parts.push({ value: hours, unit: "h" });
  if (mins && !days) parts.push({ value: mins, unit: "min" });
  return parts;
}

// Valhalla maneuver enum: https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/
export function maneuverIcon(type) {
  const icons = {
    1: "🟢", 2: "↱", 3: "↰", 4: "🏁", 5: "🏁", 6: "🏁",
    7: "↑", 8: "↑", 9: "↗", 10: "→", 11: "↱",
    12: "↪", 13: "↪", 14: "↰", 15: "←", 16: "↖",
    17: "↑", 18: "↱", 19: "↰", 20: "↱", 21: "↰",
    22: "↑", 23: "↗", 24: "↖", 25: "⇄",
    26: "⭕", 27: "↗", 28: "⛴", 29: "⛴",
  };
  return icons[type] ?? "•";
}

export function formatStepMeta(lengthKm, durationSec) {
  const parts = [];
  if (lengthKm >= 0.05) {
    parts.push(
      lengthKm < 1
        ? `${Math.round(lengthKm * 1000)} m`
        : `${lengthKm.toFixed(1)} km`,
    );
  }
  if (durationSec >= 10) {
    parts.push(
      formatDuration(durationSec)
        .map((p) => `${p.value} ${p.unit}`)
        .join(" "),
    );
  }
  return parts.join(" · ");
}

export function parseDirections(trip) {
  if (!trip?.legs) return [];
  return trip.legs.flatMap((leg, legIndex) =>
    (leg.maneuvers ?? []).map((m, i) => ({
      id: `${legIndex}-${i}`,
      type: m.type,
      instruction: m.instruction || "",
      lengthKm: m.length ?? 0,
      durationSec: m.time ?? 0,
      beginShapeIndex: m.begin_shape_index ?? 0,
      endShapeIndex: m.end_shape_index ?? 0,
      streetNames: m.street_names ?? [],
      verbalAlert: m.verbal_transition_alert_instruction || "",
      verbalPre: m.verbal_pre_transition_instruction || "",
      verbalPost: m.verbal_post_transition_instruction || "",
    })),
  );
}
