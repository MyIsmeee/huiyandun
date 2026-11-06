"""站点时区（D-106）：报告与交给模型的时刻按站点时区给出。"""

from datetime import UTC, datetime

from api_server.localtime import site_tz, stamp


def test_site_tz_names() -> None:
    assert site_tz(480).tzname(None) == "UTC+8"
    assert site_tz(330).tzname(None) == "UTC+5:30"
    assert site_tz(-300).tzname(None) == "UTC-5"


def test_stamp_converts_from_utc() -> None:
    ts = datetime(2026, 11, 4, 11, 43, tzinfo=UTC)
    assert stamp(ts, site_tz(480)) == "2026-11-04 19:43:00 UTC+8"
