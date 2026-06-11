import { parseCommand, generateTitle, sessionToMarkdown, countTokens, isValidJSON, formatJSON } from '../utils/helpers';

export function useCommands(
  onClear: () => void,
  onExport: () => void,
  onHelp: () => void
) {
  const handleCommand = (input: string): boolean => {
    const { isCommand, command } = parseCommand(input);

    if (!isCommand || !command) return false;

    switch (command) {
      case 'clear':
        onClear();
        return true;

      case 'export':
        onExport();
        return true;

      case 'help':
        onHelp();
        return true;

      default:
        return false;
    }
  };

  return { handleCommand };
}

export { generateTitle, sessionToMarkdown, countTokens, isValidJSON, formatJSON };
