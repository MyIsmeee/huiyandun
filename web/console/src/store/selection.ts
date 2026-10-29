import { create } from "zustand";

/**
 * 选中的对象（V-I2）：设备或检出目标（键为"摄像头/track_id"），二者互斥；告警的选中由后续任务接入。
 * hoveredKey：指针下的人员或车辆，显示中性灰四角括框（V-I4）；设备的悬停由其点选按钮自行呈现
 */
export const useSelection = create<{ deviceId: string | null; targetKey: string | null; hoveredKey: string | null }>()(() => ({
  deviceId: null,
  targetKey: null,
  hoveredKey: null,
}));

export const select = (deviceId: string | null) => useSelection.setState({ deviceId, targetKey: null });
export const selectTarget = (targetKey: string) => useSelection.setState({ deviceId: null, targetKey });
