export const SETTINGS_TAB_ORDER = ["model", "chat", "agent", "tools", "skills", "knowledge", "search", "data"] as const;
export type SettingsTab = (typeof SETTINGS_TAB_ORDER)[number];

const LABELS: Record<SettingsTab, [string, string]> = {
  model: ["连接与模型", "Connections"],
  chat: ["外观与回复", "Appearance & replies"],
  agent: ["工作区与权限", "Workspace & permissions"],
  tools: ["工具与 MCP", "Tools & MCP"],
  skills: ["技能", "Skills"],
  knowledge: ["知识库", "Knowledge"],
  search: ["联网搜索", "Web search"],
  data: ["数据管理", "Data"],
};
export const settingsTabLabel = (tab: SettingsTab, lang: string) => LABELS[tab][lang === "zh" ? 0 : 1];
