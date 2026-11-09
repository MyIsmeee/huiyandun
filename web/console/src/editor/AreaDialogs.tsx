import { CircleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, type SceneArea } from "../lib/api";

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
