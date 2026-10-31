import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import ConnectorComposer from './ui/ConnectorComposer.tsx';
import type { ComposerCatalog, RunSelection } from './core.ts';

export const inject = ['slots', 'connection', 'layout', 'uiWorkspace'];
const panel = 'context-connectors' as MainPanelId;
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle;
  const call = async <T,>(payload: unknown): Promise<T> => {
    const result = await connection.rpc.call('/api', 'context-connectors', payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.value as T;
  };
  const loadCatalog = (workspaceId?: string) => call<ComposerCatalog>({ action: 'catalog', workspaceId });
  const onRun = async (selection: RunSelection, prompt: string, requestId: string, workspaceId?: string) => {
    const result = await call<{ sessionId: string }>({ action: 'start', selection, prompt, requestId, workspaceId });
    ctx.uiWorkspace.openSession(result.sessionId as SessionId);
  };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, inject: () => ({ loadCatalog, onRun }) }, ConnectorComposer));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 5, label: '上下文组合' }, () => <span aria-label="上下文组合">▦</span>));
}
