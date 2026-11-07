import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并类名，后者覆盖前者的同类工具类（shadcn/ui 约定，04 §3.6） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
