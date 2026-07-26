import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * A masked text field with a reveal toggle. Hidden by default (guards against
 * shoulder-surfing); the user clicks the eye to reveal the value when they need
 * to verify it. The secret itself is kept in app state as usual — this only
 * controls on-screen display.
 */
export function SecretInput({
  value,
  onChange,
  placeholder,
  revealLabel,
  hideLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  revealLabel: string;
  hideLabel: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="secret-input">
      <input
        type={revealed ? "text" : "password"}
        className={`input-text${revealed ? "" : " is-masked"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="secret-input-toggle"
        onClick={() => setRevealed((v) => !v)}
        title={revealed ? hideLabel : revealLabel}
        aria-label={revealed ? hideLabel : revealLabel}
        aria-pressed={revealed}
      >
        {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}
