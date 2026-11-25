import { Popover } from "radix-ui";
import { FileCode2, GitCompareArrows, Sparkles } from "lucide-react";
import type { MentionOption } from "../../utils/mentions";

interface MentionSuggestionsProps {
  open: boolean;
  options: MentionOption[];
  selectedIndex: number;
  onSelect: (option: MentionOption) => void;
  lang?: string;
}

export function MentionSuggestions({
  open,
  options,
  selectedIndex,
  onSelect,
  lang = "zh",
}: MentionSuggestionsProps) {
  if (!open || options.length === 0) return null;

  return (
    <Popover.Root open modal={false}>
      <Popover.Anchor asChild>
        <span className="command-suggestions-anchor" aria-hidden="true" />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          asChild
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div
            className="command-suggestions mention-suggestions"
            role="listbox"
            aria-label={lang === "zh" ? "上下文引用" : "Context mentions"}
          >
            {options.map((option, index) => (
              <button
                type="button"
                key={option.id}
                className={`command-item mention-item ${index === selectedIndex ? "selected" : ""}`}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(option)}
              >
                <span className="mention-icon">
                  {option.kind === "git-diff" ? (
                    <GitCompareArrows size={13} />
                  ) : option.kind === "skill" ? (
                    <Sparkles size={13} />
                  ) : (
                    <FileCode2 size={13} />
                  )}
                </span>
                <span className="command-name">{option.label}</span>
                {option.subtitle && (
                  <span className="command-desc">{option.subtitle}</span>
                )}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
