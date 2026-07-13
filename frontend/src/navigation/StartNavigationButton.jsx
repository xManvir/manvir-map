// -----------------------------------------------------------------------------
// StartNavigationButton.jsx — enters live navigation from route preview.
// -----------------------------------------------------------------------------

export function StartNavigationButton({ onStart, disabled, accentColor }) {
  return (
    <button
      type="button"
      className="start-navigation-btn"
      onClick={onStart}
      disabled={disabled}
      style={{
        "--nav-accent": accentColor,
      }}
    >
      <span className="start-navigation-btn__icon" aria-hidden>
        ▶
      </span>
      Start navigation
    </button>
  );
}
