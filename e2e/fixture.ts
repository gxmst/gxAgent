import type { Page } from '@playwright/test';

export async function installFixture(page: Page) {
  await page.addInitScript(() => {
    const bridge = window as typeof window & Record<string, any>;
    localStorage.setItem('gx_current_session', 'review');
    localStorage.setItem('gx_onboarding_v1', 'complete');
    const config = { mode: 'code', workDir: 'C:/projects/gxAgent' };
    bridge.__sessions = [
      { id: 'review', title: 'Session recovery', createdAt: 1, updatedAt: 4, sessionConfig: config, messages: [
        { id: 'user1', role: 'user', content: 'Fix persistence after a session load failure.', timestamp: 1 },
        { id: 'answer1', role: 'assistant', content: 'The save guard and retry action are ready for review.', timestamp: 2,
          run: { requestId: 'finished', status: 'completed', startedAt: 1, finishedAt: 22001 },
          actions: [{ id: 'tool1', name: 'read_file', arguments: '{"path":"src/App.tsx"}', status: 'done', output: 'export const ready = true;' }] },
      ] },
      { id: 'performance', title: 'Long conversation performance', createdAt: 1, updatedAt: 3, sessionConfig: config, messages: [] },
      { id: 'another', title: 'Document generation', createdAt: 1, updatedAt: 2, sessionConfig: { ...config, workDir: 'C:/projects/document-tools' }, messages: [] },
      { id: 'chat', title: 'Discuss the roadmap', createdAt: 1, updatedAt: 1, sessionConfig: { mode: 'chat' }, messages: [] },
    ];
    bridge.__events = {};
    bridge.__calls = [];
    bridge.__fileFailure = false;
    const skill = { id: 'a'.repeat(64), name: 'docs-reader', description: 'Read project documents and cite sources.', path: 'C:/projects/gxAgent/.agents/skills/docs/SKILL.md', scope: 'project', body: 'Read documents before answering.', resources: ['references/guide.md'], dependencies: [], missingDependencies: [] };
    const hit = { chunkId: 'abcd:1234:0', documentId: 'doc-1', path: 'C:/docs/guide.md', title: 'guide.md', text: 'Local knowledge supports indexed document retrieval.', score: 1.4, startChar: 0, endChar: 60 };
    bridge.__knowledgeDocs = [{ id: 'doc-1', path: hit.path, title: hit.title, scope: '', updatedAt: Date.now(), chunks: 3, chunkSize: 800, overlap: 120 }];
    bridge.__evalCases = []; bridge.__evalRuns = [];
    bridge.__backups = [{ id: 'backup-1', sessionId: 'review', title: 'Session recovery', createdAt: Date.now(), bytes: 1024 }];
    const callbacks: Record<number, (...args: any[]) => void> = {};
    let sequence = 0;
    bridge.__emit = (event: string, payload: object) => {
      bridge.__events[event]?.(payload);
      if (event === 'agent-complete') bridge.__finishAgent?.();
    };
    bridge.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback: (...args: any[]) => void) { const id = ++sequence; callbacks[id] = callback; return id; },
      unregisterCallback(id: number) { delete callbacks[id]; },
      async invoke(command: string, args: any = {}) {
        bridge.__calls.push({ command, args });
        if (command === 'plugin:event|listen') {
          bridge.__events[args.event] = (payload: unknown) => callbacks[args.handler]?.({ event: args.event, payload, id: sequence });
          return ++sequence;
        }
        if (command === 'load_config') return { provider: 'ollama', wire_format: 'ollama', model: 'qwen3-coder', base_url: 'http://localhost:11434', language: localStorage.getItem('fixture_language') || 'en', theme: 'light', default_work_dir: config.workDir, mcp_servers: { docs: { command: 'fixture', args: [], env: {} } } };
        if (command === 'list_skills') return { skills: [skill], errors: [] };
        if (command === 'read_skill_resource') return 'Reference document content.';
        if (command === 'list_session_backups') return bridge.__backups;
        if (command === 'session_storage_issues') return localStorage.getItem('fixture_damaged_storage') ? [{ sessionId: 'review', error: 'Invalid JSON' }] : [];
        if (command === 'repair_session_backup') { localStorage.removeItem('fixture_damaged_storage'); return; }
        if (command === 'create_session_backup') { bridge.__snapshotSessions = structuredClone(bridge.__sessions); bridge.__backups.push({ ...bridge.__backups[0], id: 'backup-2' }); return; }
        if (command === 'read_session_backup') return { ...bridge.__sessions[0], id: 'restored-task', title: 'Session recovery (restored)' };
        if (command === 'inspect_mcp_tools') return [{ name: 'search_docs', description: 'Search indexed documents.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
        if (command === 'call_mcp_debug') return { result: { content: [{ type: 'text', text: 'Found a document' }], structuredContent: { count: 1 }, isError: bridge.__mcpError || false }, durationMs: 14 };
        if (command === 'list_knowledge_documents') return bridge.__knowledgeDocs;
        if (command === 'pick_knowledge_files') return ['C:/docs/new.md'];
        if (command === 'index_knowledge_file') { bridge.__knowledgeDocs.push({ ...bridge.__knowledgeDocs[0], id: 'doc-2', path: args.path, title: 'new.md' }); return 'doc-2'; }
        if (command === 'remove_knowledge_document') { bridge.__knowledgeDocs = bridge.__knowledgeDocs.filter((d: any) => d.id !== args.id); return; }
        if (command === 'search_knowledge') return { query: args.query, hits: [hit], durationMs: 3, mode: args.mode, topK: args.topK };
        if (command === 'knowledge_evaluations') return { cases: bridge.__evalCases, runs: bridge.__evalRuns };
        if (command === 'save_knowledge_case') { bridge.__evalCases.push({ id: 'case-' + bridge.__evalCases.length, question: args.question, expectedDocumentId: args.expectedDocumentId }); return; }
        if (command === 'delete_knowledge_case') { bridge.__evalCases = bridge.__evalCases.filter((c: any) => c.id !== args.id); return; }
        if (command === 'run_knowledge_evaluation') { const report = { id: 'eval-1', createdAt: Date.now(), topK: args.topK, mode: args.mode, indexRevision: 'fixture-index-revision', hitRate: 1, mrr: 1, unanswerable: 0, noAnswerCorrect: 0, results: bridge.__evalCases.map((c: any) => ({ case: c, rank: 1, report: { query: c.question, hits: [hit], durationMs: 1, mode: args.mode, topK: args.topK } })) }; bridge.__evalRuns.unshift(report); return report; }
        if (command === 'get_provider_presets') return [];
        if (command === 'load_sessions') { if (localStorage.getItem('fixture_damaged_storage')) throw new Error('Invalid session JSON'); return bridge.__sessions; }
        if (command === 'save_session') {
          if (bridge.__saveFailure) throw new Error('Session disk is unavailable');
          const index = bridge.__sessions.findIndex((session: any) => session.id === args.session.id);
          if (index < 0) bridge.__sessions.push(args.session); else bridge.__sessions[index] = args.session;
          return;
        }
        if (command === 'save_sessions') { bridge.__sessions = args.sessions; return; }
        if (command === 'fetch_ollama_models' || command === 'fetch_models') return [{ id: 'qwen3-coder' }, { id: 'deepseek-r1' }, { id: 'very-long-model-name-for-overflow-check' }];
        if (command === 'inspect_codex') return { connected: true, authenticated: true, models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model' }] };
        if (command === 'start_agent_session') return new Promise(resolve => { bridge.__finishAgent = resolve; });
        if (command === 'resolve_tool_approval') {
          if (bridge.__approvalFailure) throw new Error('Approval connection interrupted');
          if (bridge.__nextApproval) { bridge.__emit('agent-tool-approval-request', bridge.__nextApproval); bridge.__nextApproval = null; }
          return;
        }
        if (command === 'answer_codex_question') {
          if (bridge.__questionFailure) throw new Error('Answer connection interrupted');
          if (bridge.__nextQuestion) { bridge.__emit('agent-codex-question', bridge.__nextQuestion); bridge.__nextQuestion = null; }
          return;
        }
        if (command === 'list_directory_tree') return { name: 'gxAgent', path: args.workDir, kind: 'directory', size: 0, children: [{ name: 'src', path: args.workDir + '/src', kind: 'directory', size: 0, children: [{ name: 'App.tsx', path: args.workDir + '/src/App.tsx', kind: 'file', size: 1, children: [] }] }] };
        if (command === 'get_git_status') return { repositoryRoot: args.workDir, branch: 'main', entries: [{ path: 'src/App.tsx', indexStatus: ' ', worktreeStatus: 'M' }] };
        if (command === 'get_git_run_review') return { repositoryRoot: args.workDir, version: 'fixture', entries: [{ path: 'src/App.tsx', status: 'M', diff: 'diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-const ready = true;\n+const ready = false;\n' }] };
        if (command === 'get_git_diff') return 'diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-const ready = true;\n+const ready = false;\n';
        if (command === 'read_file_content') { if (bridge.__fileFailure) throw new Error('Temporary read failure'); return '// Selected file\nexport const ready = true;'; }
        if (command === 'pick_workspace_directory') return config.workDir;
        return null;
      },
    };
    bridge.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
}

export async function emit(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(({ event, payload }) => (window as any).__emit(event, payload), { event, payload });
}
