import logo from "@/assets/brand/logo.png";
import { cn } from "@/lib/utils";

/**
 * 品牌盾牌标识（无激光线版，源文件见 brand/logo/shield-front）。
 * 纯装饰：旁边总跟着"慧眼盾"文字，alt 留空以免读屏重复朗读。高度由调用方用 h-* 指定，宽度按比例。
 */
export function BrandMark({ className }: { className?: string }) {
  return <img src={logo} alt="" draggable={false} className={cn("w-auto shrink-0 select-none", className)} />;
}
