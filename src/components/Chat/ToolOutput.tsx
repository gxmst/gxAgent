import { isValidJSON, formatJSON } from '../../utils/helpers';

interface ToolOutputProps {
  output: string;
}

export function ToolOutput({ output }: ToolOutputProps) {
  // JSON output
  if (isValidJSON(output)) {
    return (
      <div className="tool-output json-output">
        <pre>{formatJSON(output)}</pre>
      </div>
    );
  }

  // Table-like output (lines with consistent delimiters)
  const lines = output.split('\n');
  if (lines.length > 2 && lines[0].includes('|') && lines.every(l => l.includes('|'))) {
    return (
      <div className="tool-output table-output">
        <table>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
                {line.split('|').filter(c => c.trim()).map((cell, j) => (
                  <td key={j}>{cell.trim()}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Plain text
  return (
    <div className="tool-output plain-output">
      <pre>{output}</pre>
    </div>
  );
}
