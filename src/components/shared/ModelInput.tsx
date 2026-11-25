import { useId, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, Check } from "lucide-react";

/** A model directory is a suggestion list; private IDs remain valid input. */
export function ModelInput({ value, onChange, models, label, placeholder, disabled = false }: {
  value: string; onChange: (value: string) => void; models: string[]; label: string; placeholder?: string; disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = Array.from(new Set([value, ...models].filter(Boolean))).filter(model => model.toLowerCase().includes(value.toLowerCase()));
  return <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Anchor asChild><div className="model-input-field">
      <input className="input-text" aria-label={label} role="combobox" aria-autocomplete="list" aria-expanded={open && !disabled} aria-controls={`${id}-list`} aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined} value={value} disabled={disabled} placeholder={placeholder} spellCheck={false}
        onFocus={() => setOpen(true)} onChange={event => { onChange(event.target.value); setOpen(true); setActive(0); }}
        onKeyDown={event => {
          if (event.key === "Escape") { setOpen(false); event.stopPropagation(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActive(index => Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
          if (event.key === "Enter" && open) { event.preventDefault(); if (options[active]) onChange(options[active]); setOpen(false); }
        }} />
      <button type="button" className="model-input-toggle" disabled={disabled} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={15} /></button>
    </div></Popover.Anchor>
    <Popover.Portal><Popover.Content className="model-input-options" side="bottom" align="start" sideOffset={6} collisionPadding={12} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      <div id={`${id}-list`} role="listbox" aria-label={label}>{options.map((model, index) => <button type="button" id={`${id}-${index}`} key={model} role="option" aria-selected={model === value} tabIndex={-1} className={active === index ? "highlighted" : ""} onPointerDown={event => event.preventDefault()} onClick={() => { onChange(model); setOpen(false); }}><span>{model}</span>{model === value && <Check size={14} />}</button>)}</div>
      <div className="model-input-help">{placeholder}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
