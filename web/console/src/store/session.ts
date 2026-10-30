import { create } from "zustand";
import type { components } from "../api/schema";

export type Role = components["schemas"]["Role"];

/** 会话角色：未知时不渲染任何需要权限的操作（C-FE-07） */
export const useSession = create<{ role: Role | null }>()(() => ({ role: null }));

/** 可执行处置的角色（C-BE-07：viewer ⊂ operator ⊂ admin，auditor 只读审计） */
export const canContain = (role: Role | null) => role === "operator" || role === "admin";
