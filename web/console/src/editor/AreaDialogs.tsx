import { CircleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, type SceneArea } from "../lib/api";
import { useCatalog } from "../scene/assets";
import type { CameraPlacement } from "./cameras";
import { isDirty, useDraft } from "./draft";
import { inside } from "./placement";

const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : "无法连接服务器，请重试");

/** 新建区域（FR-908）：名称与尺寸，尺寸为整米；默认取站点尺寸 */
export function NewAreaDialog(props: { size: [number, number]; onCreated: (area: SceneArea) => void; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const area = await api.createSceneArea({
        name: String(form.get("name")).trim(),
        width_m: Number(form.get("width")),
        depth_m: Number(form.get("depth")),
      });
      props.onCreated(area);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogTitle className="text-base font-medium">新建区域</DialogTitle>
        <form onSubmit={submit} className="grid gap-4 text-sm">
          <Label className="grid gap-1.5">
            名称
            <Input name="name" required maxLength={40} pattern=".*\S.*" placeholder="如：一号楼大厅" autoFocus />
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <Label className="grid gap-1.5">
              宽（米）
              <Input name="width" type="number" required min={1} max={500} step={1} defaultValue={props.size[0]} />
            </Label>
            <Label className="grid gap-1.5">
              深（米）
              <Input name="depth" type="number" required min={1} max={500} step={1} defaultValue={props.size[1]} />
            </Label>
          </div>
          {error && (
            <p role="alert" className="flex items-center gap-1">
              <CircleAlert aria-hidden className="size-4" />
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "新建中…" : "新建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 删除区域：区域内仍有摄像头时服务端返回 409，以提示说明原因，区域保留 */
export function DeleteAreaDialog(props: { area: SceneArea; onDeleted: () => void; onClose: () => void }) {
  const { area } = props;
  const [pending, setPending] = useState(false);

  async function remove() {
    setPending(true);
    try {
      await api.deleteSceneArea(area.id);
      toast.success(`已删除区域"${area.name}"`);
      props.onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    }
    props.onClose();
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogTitle className="text-base font-medium">删除区域</AlertDialogTitle>
        <AlertDialogDescription>
          删除区域"{area.name}"及其中搭建的全部物体？区域内还有摄像头时不能删除，请先把摄像头移到其他区域。
        </AlertDialogDescription>
        <p className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button size="sm" disabled={pending} onClick={() => void remove()}>
            删除
          </Button>
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 区域尺寸的取值范围（契约 SceneAreaUpdate：整米 1～500） */
const SIZE_MIN = 1;
const SIZE_MAX = 500;

function sizeError(text: string): string | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isInteger(value)) return "请填写整米数";
  if (value < SIZE_MIN || value > SIZE_MAX) return `须在 ${SIZE_MIN}～${SIZE_MAX} m 之间`;
  return null;
}

/**
 * 缩小后放不下的物体与摄像头：物体按占地判断（比服务端只看放置点更严，免得物体一半落在区域外），
 * 摄像头按放置点判断，与服务端 _check_inside 一致
 */
export function outsideAfterResize(
  items: SceneArea["items"],
  cameras: CameraPlacement[],
  catalog: Parameters<typeof inside>[1],
  size: [number, number],
): { items: number; cameras: string[] } {
  return {
    items: items.filter((item) => !inside(item, catalog, size)).length,
    cameras: cameras.filter((c) => c.x > size[0] || c.y > size[1]).map((c) => c.id),
  };
}

/**
 * 编辑区域（FR-908）：名称与宽深。区域与其中的物体、摄像头位置是同一份整体保存的数据（PUT 带 updated_at），
 * 所以只在没有未保存的修改时可改：提交的物体与摄像头位置取已保存的内容，不会把未保存的草稿顺带存进去。
 * 缩小到放不下已有物体或摄像头时不提交，说明要先移动或删除哪些
 */
export function EditAreaDialog(props: { area: SceneArea; cameras: CameraPlacement[]; onSaved: () => void; onClose: () => void }) {
  const { area } = props;
  const catalog = useCatalog();
  const dirty = useDraft(isDirty);
  const draft = useDraft((s) => (s.areaId === area.id ? s : null));
  const items = draft?.saved ?? area.items;
  const cameras = draft?.savedCameras ?? props.cameras;
  const [name, setName] = useState(area.name);
  const [width, setWidth] = useState(String(area.width_m));
  const [depth, setDepth] = useState(String(area.depth_m));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const widthError = sizeError(width);
  const depthError = sizeError(depth);
  const nameError = name.trim() === "" ? "请填写名称" : null;
  const outside = widthError || depthError ? null : outsideAfterResize(items, cameras, catalog, [Number(width), Number(depth)]);
  const blocked = outside !== null && (outside.items > 0 || outside.cameras.length > 0);
  const unchanged = name.trim() === area.name && Number(width) === area.width_m && Number(depth) === area.depth_m;
  const disabled = pending || dirty || unchanged || blocked || nameError !== null || widthError !== null || depthError !== null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await api.saveSceneArea(area.id, {
        name: name.trim(),
        width_m: Number(width),
        depth_m: Number(depth),
        items,
        cameras,
        updated_at: draft?.updatedAt ?? area.updated_at,
      });
      toast.success(`已更新区域"${name.trim()}"`);
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "区域已被其他人修改：关闭后会载入最新内容，再重新修改" : errorMessage(err));
      if (err instanceof ApiError && err.status === 409) props.onSaved();
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogTitle className="text-base font-medium">编辑区域</DialogTitle>
        <form onSubmit={submit} className="grid gap-4 text-sm" noValidate>
          {dirty && (
            <p role="status" className="rounded-md border border-dashed px-3 py-2 text-muted-foreground">
              场景有未保存的修改：先保存或放弃，再修改区域的名称与尺寸。
            </p>
          )}
          <Label className="grid gap-1.5">
            名称
            <Input value={name} maxLength={40} aria-invalid={nameError !== null} onChange={(e) => setName(e.target.value)} autoFocus />
            {nameError && <span className="text-xs text-destructive">{nameError}</span>}
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <Label className="grid gap-1.5">
              宽（米，沿 x）
              <Input value={width} inputMode="numeric" aria-invalid={widthError !== null} onChange={(e) => setWidth(e.target.value)} />
              {widthError && <span className="text-xs text-destructive">{widthError}</span>}
            </Label>
            <Label className="grid gap-1.5">
              深（米，沿 y）
              <Input value={depth} inputMode="numeric" aria-invalid={depthError !== null} onChange={(e) => setDepth(e.target.value)} />
              {depthError && <span className="text-xs text-destructive">{depthError}</span>}
            </Label>
          </div>
          <p className="text-xs text-subtle-foreground">原点在区域一角（俯视时为左上角）：放大只在另外两侧加出空地，已摆放的物体与摄像头位置不变。</p>
          {blocked && outside && (
            <p role="alert" className="flex items-start gap-1 text-destructive">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                缩小后会超出区域：
                {[outside.items > 0 && `${outside.items} 件物体`, outside.cameras.length > 0 && `摄像头 ${outside.cameras.join("、")}`]
                  .filter(Boolean)
                  .join("，")}
                。先在场景中移动或删除它们，或改用更大的尺寸。
              </span>
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-center gap-1">
              <CircleAlert aria-hidden className="size-4" />
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={props.onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={disabled}>
              {pending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
