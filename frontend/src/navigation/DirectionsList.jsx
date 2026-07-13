// -----------------------------------------------------------------------------
// DirectionsList.jsx — scrollable turn-by-turn steps (route preview).
// -----------------------------------------------------------------------------

import { useState } from "react";
import { formatStepMeta, maneuverIcon } from "./parseDirections.js";

export function DirectionsList({ steps, accentColor, isMobile }) {
  const [expanded, setExpanded] = useState(true);

  if (!steps?.length) return null;

  return (
    <div
      className="directions-list"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
        order: isMobile ? 5 : 0,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="directions-list__toggle"
      >
        <span>Directions ({steps.length} steps)</span>
        <span
          className="directions-list__chevron"
          data-expanded={expanded ? "true" : "false"}
        >
          ▾
        </span>
      </button>
      {expanded && (
        <ol className="directions-list__steps">
          {steps.map((step, i) => {
            const meta = formatStepMeta(step.lengthKm, step.durationSec);
            const isLast = i === steps.length - 1;
            return (
              <li
                key={step.id}
                className="directions-list__step"
                data-last={isLast ? "true" : "false"}
              >
                <span
                  aria-hidden
                  className="directions-list__icon"
                  style={{ color: accentColor }}
                >
                  {maneuverIcon(step.type)}
                </span>
                <div className="directions-list__text">
                  <div className="directions-list__instruction">
                    {step.instruction}
                  </div>
                  {meta && (
                    <div className="directions-list__meta">{meta}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
