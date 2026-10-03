import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 仅保存当前操作人身份（演示两人同改一条时的并发冲突）；业务数据不再放前端。
type IdentityState = {
  actor: string;
  setActor: (actor: string) => void;
};

export const useIdentity = create<IdentityState>()(
  persist(
    (set) => ({
      actor: '核验员·沈楠',
      setActor: (actor) => set({ actor })
    }),
    { name: 'yy60-identity' }
  )
);
