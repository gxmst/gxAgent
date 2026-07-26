import { useEffect, useState } from "react";

let mermaidIdCounter = 0;

export default function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++mermaidIdCounter}`;
    setSvg("");
    setError("");

    void Promise.all([import("mermaid"), import("dompurify")])
      .then(async ([{ default: mermaid }, { default: DOMPurify }]) => {
        const result = await mermaid.render(id, chart);
        if (cancelled) return;

        const sanitized = DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ["foreignObject"],
        });
        setSvg(sanitized);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="mermaid-container">
        <pre style={{ color: "var(--error)", fontSize: "0.75rem" }}>{`Mermaid error: ${error}`}</pre>
      </div>
    );
  }

  if (svg) {
    return <div className="mermaid-container" dangerouslySetInnerHTML={{ __html: svg }} />;
  }

  return <div className="mermaid-container" aria-busy="true" />;
}
