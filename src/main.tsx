import React from "react";
import ReactDOM from "react-dom/client";
// Bundle the design fonts locally — the CSS has referenced Inter/JetBrains Mono
// since day one, but without these imports it silently fell back to Segoe
// UI/Consolas on every machine.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import App from "./App";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { initAgentEventListeners } from "./services/agentEvents";

// Agent event listeners live for the app lifetime, outside React: streaming
// events mutate the zustand store directly instead of re-registering through
// component effects. (Guarded internally, so HMR re-imports are no-ops.)
void initAgentEventListeners();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
