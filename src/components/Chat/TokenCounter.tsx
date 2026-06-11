import { countTokens } from '../../utils/helpers';

interface TokenCounterProps {
  text: string;
}

export function TokenCounter({ text }: TokenCounterProps) {
  const count = countTokens(text);

  return (
    <div className="token-counter">
      {count} tokens
    </div>
  );
}
