import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  copied?: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('App crashed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const isZh = (navigator.language || "").toLowerCase().startsWith("zh");
      const details = this.state.error?.stack || this.state.error?.message || "Unknown error";
      return (
        <div className="error-screen" role="alert">
          <div className="error-screen-card">
            <div className="error-screen-icon" aria-hidden="true">!</div>
            <h1>{isZh ? "gxAgent 暂时无法继续" : "gxAgent could not continue"}</h1>
            <p>
              {isZh
                ? "你的会话数据仍保存在本机。可以重新加载应用，或复制诊断信息后再排查。"
                : "Your local sessions are still saved. Reload the app or copy diagnostics for troubleshooting."}
            </p>
            <pre className="error-screen-details">{this.state.error?.message || details}</pre>
            <div className="error-screen-actions">
              <button className="btn btn-primary" onClick={() => window.location.reload()}>
                {isZh ? "重新加载" : "Reload"}
              </button>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(details);
                  this.setState({ copied: true });
                }}
              >
                {this.state.copied
                  ? (isZh ? "已复制" : "Copied")
                  : (isZh ? "复制诊断" : "Copy diagnostics")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
