'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAuditEvents, fetchState, submitCommand, type CommandRequest } from './api';

export const STATE_KEY = ['audit-state'] as const;
export const EVENTS_KEY = ['audit-events'] as const;

export function useAuditState() {
  return useQuery({ queryKey: STATE_KEY, queryFn: fetchState });
}

export function useAuditEvents(enabled: boolean) {
  return useQuery({ queryKey: EVENTS_KEY, queryFn: fetchAuditEvents, enabled });
}

export type CommandOutcome = {
  ok: boolean;
  status: string;
  replayed: boolean;
  message: string;
  conflictOfSeq?: number;
};

export function useAuditCommand() {
  const queryClient = useQueryClient();
  const mutation = useMutation<CommandOutcome, Error, CommandRequest>({
    mutationFn: async (command) => {
      const result = await submitCommand(command);
      if (result.status === 'applied') {
        return { ok: true, status: result.status, replayed: result.replayed, message: result.replayed ? '同号重试，返回的是首次结果' : '操作已追加到审计链' };
      }
      if (result.status === 'conflict') {
        return { ok: false, status: result.status, replayed: result.replayed, message: result.error ?? '后到冲突：先到操作已成立，本次已留冲突记录', conflictOfSeq: result.conflictOfSeq };
      }
      if (result.status === 'chain-broken') {
        return { ok: false, status: result.status, replayed: false, message: '审计链已断，写入已冻结' };
      }
      return { ok: false, status: result.status, replayed: false, message: result.error ?? '操作被拒绝' };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATE_KEY });
      void queryClient.invalidateQueries({ queryKey: EVENTS_KEY });
    }
  });
  return mutation;
}
