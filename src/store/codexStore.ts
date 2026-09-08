import { create } from "zustand";

export interface CodexModel { id: string; model: string; displayName: string }
export interface CodexQuestion {
  interactionId: string;
  questions: { id: string; header: string; question: string; isSecret?: boolean; options?: { label: string; description: string }[] | null }[];
}

export const useCodexStore = create<{
  models: CodexModel[];
  executable: string;
  questions: Record<string, CodexQuestion | null>;
  setQuestion: (sessionId: string, question: CodexQuestion | null) => void;
}>(set => ({
  models: [], executable: "", questions: {},
  setQuestion: (sessionId, question) => set(state => ({ questions: { ...state.questions, [sessionId]: question } })),
}));
