"""站点时区（D-106）：报告与交给模型的时刻按站点时区给出，与界面一致；存储与事件仍为 UTC（G-10、CD-07）。"""

from datetime import datetime, timedelta, timezone


def site_tz(offset_min: int) -> timezone:
    """与 UTC 相差 offset_min 分钟的固定时区，名称如 UTC+8、UTC+5:30。"""
    hours, minutes = divmod(abs(offset_min), 60)
    name = f"UTC{'-' if offset_min < 0 else '+'}{hours}" + (f":{minutes:02d}" if minutes else "")
    return timezone(timedelta(minutes=offset_min), name)


def stamp(ts: datetime, tz: timezone) -> str:
    """报告中的时刻，如 2026-11-04 19:43:00 UTC+8。"""
    local = ts.astimezone(tz)
    return f"{local:%Y-%m-%d %H:%M:%S} {local.tzname()}"
