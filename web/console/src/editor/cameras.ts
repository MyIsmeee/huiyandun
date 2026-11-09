import type { components } from "../api/schema";
import type { Camera } from "../scene/devices";
import type { Device } from "../store/live";

export type CameraPlacement = components["schemas"]["CameraPlacement"];

/** 朝向归一到 [0, 360)：保存接口只接受这个范围 */
export const normalizedYaw = (deg: number) => ((deg % 360) + 360) % 360;

/** 登记表中位于该区域的摄像头的位置与朝向（设计 150 E-5） */
export function areaPlacements(devices: Device[], areaId: string): CameraPlacement[] {
  return devices.flatMap(({ id, camera }) =>
    camera?.area_id === areaId ? [{ id, x: camera.pose.x, y: camera.pose.y, yaw_deg: normalizedYaw(camera.pose.yaw_deg) }] : [],
  );
}

/** 登记表中的全部摄像头（含未放入区域的），供放置预览按编号取外观与安装参数 */
export const registryCameras = (devices: Device[]): Camera[] =>
  placedCameras(
    devices,
    devices.flatMap(({ id, camera }) => (camera ? [{ id, x: camera.pose.x, y: camera.pose.y, yaw_deg: camera.pose.yaw_deg }] : [])),
  );

/** 草稿中放在区域里的摄像头：外观取登记表的状态与安装参数，位置与朝向取草稿 */
export function placedCameras(devices: Device[], placements: CameraPlacement[]): Camera[] {
  return placements.flatMap(({ id, x, y, yaw_deg }) => {
    const device = devices.find((d) => d.id === id);
    if (!device?.camera) return [];
    const { name, state, camera } = device;
    return [{ id, name, state, mapped: camera.mapping !== "none", severe: false, pose: { ...camera.pose, x, y, yaw_deg } }];
  });
}
