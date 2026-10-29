import { create } from "zustand";

/** 选中的对象（V-I2）：设备或检出目标（键为"摄像头/track_id"），二者互斥；告警的选中由后续任务接入 */
export const useSelection = create<{ deviceId: string | null; targetKey: string | null }>()(() => ({
  deviceId: null,
  targetKey: null,
}));

export const select = (deviceId: string | null) => useSelection.setState({ deviceId, targetKey: null });
export const selectTarget = (targetKey: string) => useSelection.setState({ deviceId: null, targetKey });
