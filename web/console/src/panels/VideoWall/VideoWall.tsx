import { VideoOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Device } from "../../store/live";
import { useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { setPage, toggleZoom, useWall } from "../../store/wall";
import { type Grid, pageCount, pageItems, pageOf, tileSize, wallGrid } from "./grid";
import { VideoTile } from "./VideoTile";

/** 格间距与四周留白（04 §3.5） */
const GAP = 8;
const ZOOMED: Grid = { cols: 1, rows: 1, capacity: 1, featured: false, fixed: false };

/**
 * 监控墙（HYD-UIX-004 §4.3、D-115）：登记顺序的摄像头按宫格分页播放实时画面；
 * 不在当前页的摄像头不建立连接（V-W3）。选中的摄像头不在当前页时自动翻到所在页（V-W1）。
 */
export function VideoWall({ devices }: { devices: Device[] }) {
  const pushed = useLive((s) => s.devices);
  const cameras = useMemo(() => devices.filter((d) => d.camera).map((d) => pushed[d.id] ?? d), [devices, pushed]);
  const { layout, page, zoomed } = useWall();
  const selectedId = useSelection((s) => s.deviceId);
  const grid = wallGrid(cameras.length, layout);
  const pages = pageCount(cameras.length, grid);
  const current = Math.min(page, pages - 1);

  // 只在选中变化时翻页，用户之后手动翻页不被拉回
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === followed.current) return;
    followed.current = selectedId;
    if (!selectedId) return;
    const target = pageOf(cameras, grid, selectedId, selectedId);
    if (target !== null && target !== current) setPage(target);
  }, [selectedId, cameras, grid, current]);

  const [ref, size] = useSize();
  const zoomedCamera = zoomed ? cameras.find((c) => c.id === zoomed) : undefined;
  // 放大的摄像头被删除：清掉放大状态，宫格与分页一并恢复
  useEffect(() => {
    if (zoomed && !zoomedCamera) useWall.setState({ zoomed: null });
  }, [zoomed, zoomedCamera]);
  const shown = zoomedCamera ? ZOOMED : grid;
  const items = zoomedCamera ? [zoomedCamera] : pageItems(cameras, grid, current, selectedId);
  const tile = size ? tileSize(size.w, size.h, shown, GAP) : null;

  // Esc 还原放大（V-W4）；选中时 Esc 由检查栏先用于返回告警
  useEffect(() => {
    if (!zoomedCamera) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || selectedId) return;
      toggleZoom(zoomedCamera.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomedCamera, selectedId]);

  return (
    <div ref={ref} data-wall={shown.cols * shown.rows} className="absolute inset-0 grid place-content-center bg-background">
      {cameras.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-subtle-foreground">
          <VideoOff aria-hidden className="size-4" />
          尚未登记摄像头
        </p>
      ) : (
        tile && (
          <div
            role="list"
            aria-label="监控墙"
            className="grid"
            style={{
              gap: GAP,
              gridTemplateColumns: `repeat(${shown.cols}, ${tile.w}px)`,
              gridTemplateRows: `repeat(${shown.rows}, ${tile.h}px)`,
            }}
          >
            {items.map((camera, i) => {
              const span = shown.featured && i === 0 ? { gridColumn: "span 2", gridRow: "span 2" } : undefined;
              if (!camera) return <div key={`empty-${i}`} role="listitem" aria-label="空位" className="rounded-lg border border-dashed" />;
              return (
                <div key={camera.id} role="listitem" style={span} className="min-h-0">
                  <VideoTile
                    device={camera}
                    selected={camera.id === selectedId}
                    unmapped={camera.camera?.mapping === "none"}
                    onSelect={() => select(camera.id)}
                    onZoom={() => toggleZoom(camera.id)}
                    style={{ width: "100%", height: "100%" }}
                  />
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
