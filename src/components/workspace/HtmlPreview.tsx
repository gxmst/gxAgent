import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Monitor, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";

const CONSOLE_BRIDGE = `(function(){for(const type of ['log','error','warn','info']){const original=console[type];console[type]=function(...args){original.apply(console,args);const text=args.map(value=>{try{return typeof value==='object'?JSON.stringify(value):String(value)}catch{return String(value)}}).join(' ');parent.postMessage({type:'gx-preview-log',level:type,text},'*')}}window.addEventListener('error',event=>parent.postMessage({type:'gx-preview-log',level:'error',text:event.message},'*'))})()`;

export function HtmlPreview({ sessionId, lang, sandbox }: { sessionId: string; lang: string; sandbox: boolean }) {
  const zh = lang === "zh";
  const source = useAppStore(state => state.previewBySession[sessionId] || "");
  const logs = useAppStore(state => state.previewConsoleLogsBySession[sessionId]);
  const setLogs = useAppStore(state => state.setPreviewConsoleLogsBySession);
  const [device, setDevice] = useState("desktop");
  const [revision, setRevision] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const documentSource = useMemo(() => {
    if (!source) return "";
    const document = new DOMParser().parseFromString(source, "text/html");
    const script = document.createElement("script");
    script.textContent = CONSOLE_BRIDGE;
    document.head.prepend(script);
    return "<!doctype html>" + document.documentElement.outerHTML;
  }, [source]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "gx-preview-log" || typeof event.data.text !== "string" || !["log", "error", "warn", "info"].includes(event.data.level)) return;
      setLogs(previous => ({ ...previous, [sessionId]: [...(previous[sessionId] || []), { text: event.data.text.slice(0, 10000), type: event.data.level }].slice(-200) }));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [sessionId, setLogs]);
  return <div className="html-preview">
    <div className="preview-toolbar">
      <span className="preview-label">HTML</span>
      <div role="group" aria-label={zh ? "预览尺寸" : "Preview size"}>
        <button className="panel-toggle-btn" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")} title={zh ? "桌面" : "Desktop"} aria-label={zh ? "桌面" : "Desktop"}><Monitor size={15} /></button>
        <button className="panel-toggle-btn" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")} title={zh ? "手机" : "Mobile"} aria-label={zh ? "手机" : "Mobile"}><Smartphone size={15} /></button>
      </div>
      <button className="panel-toggle-btn" disabled={!source} onClick={() => setRevision(value => value + 1)} aria-label={zh ? "重新加载预览" : "Reload preview"} title={zh ? "重新加载预览" : "Reload preview"}><RefreshCw size={14} /></button>
    </div>
    {source ? <div className="preview-frame-wrapper"><iframe key={revision} ref={frame} className={`preview-iframe ${device}`} sandbox={sandbox ? "allow-scripts" : undefined} srcDoc={documentSource} title={zh ? "HTML 预览" : "HTML preview"} /></div> : <div className="workspace-empty-state"><Eye size={27} /><span>{zh ? "暂无 HTML 预览" : "No HTML preview"}</span></div>}
    {!!logs?.length && <details className="preview-log"><summary>{zh ? "预览日志" : "Preview logs"}<button className="panel-toggle-btn" onClick={event => { event.preventDefault(); setLogs(previous => ({ ...previous, [sessionId]: [] })); }} aria-label={zh ? "清空预览日志" : "Clear preview logs"} title={zh ? "清空预览日志" : "Clear preview logs"}><Trash2 size={13} /></button></summary><div className="preview-console">{logs.map((log, index) => <div className={`preview-console-line ${log.type}`} key={index}>{log.text}</div>)}</div></details>}
  </div>;
}
