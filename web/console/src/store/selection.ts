import { create } from "zustand";

/** 选中的对象（V-I2）：M0 只有设备可选，人员与告警的选中由 #60 接入 */
export const useSelection = create<{ deviceId: string | null }>()(() => ({ deviceId: null }));

export const select = (deviceId: string | null) => useSelection.setState({ deviceId });
