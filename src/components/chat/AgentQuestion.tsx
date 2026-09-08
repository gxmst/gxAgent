import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, MessageCircleQuestion } from "lucide-react";
import { useCodexStore, type CodexQuestion } from "../../store/codexStore";

export function AgentQuestion({ question, sessionId, lang }: { question: CodexQuestion; sessionId: string; lang: string }) {
  const zh = lang === "zh";
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  return <form className="agent-question" onSubmit={async event => {
    event.preventDefault(); setSubmitting(true); setError("");
    try {
      await invoke("answer_codex_question", { interactionId: question.interactionId, answers: Object.fromEntries(question.questions.map(item => [item.id, [answers[item.id]]])) });
      const state = useCodexStore.getState();
      if (state.questions[sessionId]?.interactionId === question.interactionId) state.setQuestion(sessionId, null);
    } catch (reason) { setError(String(reason)); }
    finally { setSubmitting(false); }
  }}>
    <div className="agent-question-title"><MessageCircleQuestion size={16} />{zh ? "需要你的决定" : "Your input is needed"}</div>
    {question.questions.map(item => <fieldset key={item.id} disabled={submitting}><legend>{item.question}</legend>
      {item.options?.map(option => <label className="agent-question-option" key={option.label}><input type="radio" name={item.id} checked={answers[item.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [item.id]: option.label }))} /><span>{option.label}<small>{option.description}</small></span></label>)}
      <input className="input-text" type={item.isSecret ? "password" : "text"} aria-label={item.header || item.question} placeholder={zh ? "填写回复" : "Your answer"} value={answers[item.id] || ""} onChange={event => setAnswers(previous => ({ ...previous, [item.id]: event.target.value }))} required />
    </fieldset>)}
    {error && <div className="workspace-inline-state error" role="alert">{error}</div>}
    <button className="btn" type="submit" disabled={submitting || question.questions.some(item => !answers[item.id]?.trim())}><ArrowUp size={14} />{zh ? "提交回复" : "Submit answer"}</button>
  </form>;
}
