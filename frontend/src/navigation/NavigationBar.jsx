// -----------------------------------------------------------------------------
// NavigationBar.jsx — minimal UI shown during active navigation (Phase 1).
// -----------------------------------------------------------------------------

import { formatDuration } from "./parseDirections.js";

export function NavigationBar({
  destinationName,
  routeInfo,
  onEnd,
  accentColor,
  navError,
}) {
  const durationParts = routeInfo
    ? formatDuration(routeInfo.durationSec)
    : [];

  return (
    <div className="navigation-bar">
      <div className="navigation-bar__main">
        <div className="navigation-bar__status" style={{ color: accentColor }}>
          Navigating
        </div>
        <div className="navigation-bar__dest">
          {destinationName || "Destination"}
        </div>
        {routeInfo && (
          <div className="navigation-bar__meta">
            {routeInfo.distance} km
            {durationParts.length > 0 && (
              <>
                {" · "}
                {durationParts.map((p, i) => (
                  <span key={i}>
                    {p.value} {p.unit}{" "}
                  </span>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="navigation-bar__end"
        onClick={onEnd}
        aria-label="End navigation"
      >
        End
      </button>
      {navError && (
        <div className="navigation-bar__error" role="alert">
          {navError}
        </div>
      )}
    </div>
  );
}
