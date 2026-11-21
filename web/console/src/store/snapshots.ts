import { useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * 各摄像头最近一次抓到的画面（JPEG）。摄像头栏缩略图按间隔刷新时写入；实时画面连接期间拿它垫底：
 * WebRTC 要等到下一个关键帧、且整帧收齐才出第一帧，手机推流码率高（实测 15～25 Mbps）时要等好几秒，
 * 先显示最近的截图，第一帧到了由视频自然盖住（video 的 poster）。只存 Blob，各处自建、自释放对象 URL
 */
const latest = new Map<string, Blob>();

export function putSnapshot(id: string, blob: Blob): void {
  latest.set(id, blob);
}

/** 垫底画面的对象 URL：有缓存即用，没有就抓一帧；卸载时释放 */
export function usePoster(id: string): string | null {
  const [shot, setShot] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let active = true;
    const show = (blob: Blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob);
      setShot({ id, url });
    };
    const cached = latest.get(id);
    if (cached) show(cached);
    else
      api.getCameraSnapshot(id).then(
        (blob) => {
          putSnapshot(id, blob);
          show(blob);
        },
        () => undefined,
      );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return shot?.id === id ? shot.url : null;
}
