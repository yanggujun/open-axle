"""Dynamic version computation matching build.sh logic."""

import time
from datetime import datetime

MAJOR = 0
MINOR = 1
BUILD_DATE = "2026-07-17"


def _get_build_version():
    build_date_epoch = int(datetime.strptime(BUILD_DATE, "%Y-%m-%d").timestamp())
    now_epoch = int(time.time())
    days = (now_epoch - build_date_epoch) // 86400
    last4 = now_epoch % 10000
    return f"{MAJOR}.{MINOR}.{days:04d}.{last4:04d}"


__version__ = _get_build_version()
