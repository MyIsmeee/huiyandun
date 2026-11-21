import { create } from "zustand";

/**
 * 选中的对象（V-I2）：设备或检出目标（键为"摄像头/track_id"），二者互斥；告警的选中由后续任务接入。
 * incidentId：在告警栏点选的关联事件，详情面板的时间线、AI 研判、报告与证据包都按它显示；为 null 时取该设备最近的一起。
 * 同一设备先后发生多起事件时，点哪起就看哪起、导出哪起的证据
 * hoveredKey：指针下的人员或车辆，显示中性灰四角括框（V-I4）；设备的悬停由其点选按钮自行呈现
 */
export const useSelection = create<{
  deviceId: string | null;
  incidentId: string | null;
  targetKey: string | null;
  hoveredKey: string | null;
}>()(() => ({
  deviceId: null,
  incidentId: null,
  targetKey: null,
  hoveredKey: null,
}));

export const select = (deviceId: string | null) => useSelection.setState({ deviceId, incidentId: null, targetKey: null });
/** 选中一起关联事件：同时选中其设备，详情面板改为显示这一起 */
export const selectIncident = (incident: { id: string; device_ids: string[] }) =>
  useSelection.setState({ deviceId: incident.device_ids[0] ?? null, incidentId: incident.id, targetKey: null });
export const selectTarget = (targetKey: string) => useSelection.setState({ deviceId: null, incidentId: null, targetKey });
