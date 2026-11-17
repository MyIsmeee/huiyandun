import { Film } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, api } from "../../lib/api";
import { formatStamp } from "../ConnectionStatus/ConnectionStatus";

/**
 * 回放单条告警前后的录像：行为从开始前 10 s 到确认后 10 s，区域与越线从发生前 10 s 起（api-server 定时段）。
 * 打开时才取，关闭即释放
 */
export function ClipButton({ eventId, title, camera, ts, size = "xs" }: { eventId: string; title: string; camera: string; ts: string; size?: "xs" | "sm" }) {
  const [open, setOpen] = useState(false);
  const [clip, setClip] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });

  useEffect(() => {
    if (!open) return;
    let url: string | null = null;
    let live = true;
    api.getAlertClip(eventId).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        if (live) setClip({ url, error: null });
      },
      (e: unknown) => live && setClip({ url: null, error: e instanceof ApiError ? e.message : "取不到录像，请检查网络后重试" }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, eventId]);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={size === "xs" ? "h-6 px-2 text-xs" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setClip({ url: null, error: null });
          setOpen(true);
        }}
      >
        <Film aria-hidden className="size-3.5" />
        回放
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{title} · 录像回放</DialogTitle>
            <DialogDescription>
              {camera} · {formatStamp(Date.parse(ts))}；告警前 10 秒到告警后 10 秒
            </DialogDescription>
          </DialogHeader>
          <div className="grid aspect-video place-items-center overflow-hidden rounded-md bg-black text-sm text-white/70">
            {clip.url ? (
              // biome-ignore lint/a11y/useMediaCaption: 监控录像没有字幕
              <video src={clip.url} controls autoPlay className="size-full object-contain" />
            ) : (
              <p>{clip.error ?? "正在取录像…"}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
