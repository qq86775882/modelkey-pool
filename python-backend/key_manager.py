"""
Key Manager —— Key 池管理核心。

职责：
1. 维护多把 Key 的日调用计数
2. 按「剩余可用次数最多」策略智能选 Key
3. 遇到 429 时自动冷却 Key
4. 每日午夜自动重置所有计数
5. 支持 CRUD：增删改查
"""
import time
import threading
import logging
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta

from config import DAILY_LIMIT, KEYS_FILE

logger = logging.getLogger("modelkey-pool")


@dataclass
class KeyState:
    """单把 Key 的状态"""
    key: str
    masked: str                    # 脱敏展示用（如 ms-abc***xyz）
    daily_count: int = 0           # 今日已调用次数
    cooldown_until: float = 0.0    # 冷却结束时间戳（0 = 未冷却）
    total_requests: int = 0        # 历史总请求数（统计用）
    total_429: int = 0             # 历史 429 次数
    last_used: float = 0.0         # 最后使用时间戳

    @property
    def is_cooling(self) -> bool:
        return time.time() < self.cooldown_until

    @property
    def is_exhausted(self) -> bool:
        """日配额用完"""
        return self.daily_count >= DAILY_LIMIT

    @property
    def cooldown_remaining(self) -> float:
        """剩余冷却秒数"""
        return max(0.0, self.cooldown_until - time.time())

    def cool(self, seconds: float = 300):
        """触发冷却，默认 5 分钟"""
        self.cooldown_until = time.time() + seconds
        logger.warning(f"Key {self.masked} 进入冷却 {seconds}s")

    def reset_daily(self):
        """重置每日计数"""
        self.daily_count = 0
        self.cooldown_until = 0.0
        logger.info(f"Key {self.masked} 日计数已重置")


def _mask(key: str) -> str:
    return key[:6] + "***" + key[-4:] if len(key) > 10 else "***"


class KeyManager:
    """
    Key 池管理器（单例）。

    选 Key 策略：
    1. 跳过冷却中的 Key
    2. 跳过日配额用完的 Key
    3. 在可用 Key 中选「剩余可用次数最多」的那把（负载均衡）
    """

    def __init__(self, keys: list[str]):
        self._states: dict[str, KeyState] = {}
        if keys:
            for k in keys:
                self._states[k] = KeyState(key=k, masked=_mask(k))
        self._lock = threading.Lock()
        self._stop_reset_timer = threading.Event()
        self._start_midnight_reset_timer()
        logger.info(f"KeyManager 初始化完成，共 {len(keys)} 把 Key，日限额 {DAILY_LIMIT}")

    # ---------- 持久化 ----------

    def _save_to_file(self):
        """保存所有 Key 到 keys.json（保留统计信息）"""
        with self._lock:
            data = []
            for st in self._states.values():
                data.append({
                    "key": st.key,
                    "total_requests": st.total_requests,
                    "total_429": st.total_429,
                })
        try:
            with open(KEYS_FILE, "w") as f:
                json.dump(data, f, indent=2)
            logger.debug(f"已保存 {len(data)} 把 Key 到 {KEYS_FILE}")
        except Exception as e:
            logger.error(f"保存 keys.json 失败: {e}")

    # ---------- CRUD ----------

    def add_key(self, key: str) -> dict:
        """添加一把新 Key，返回结果"""
        key = key.strip()
        if not key:
            return {"ok": False, "error": "Key 不能为空"}
        if not key.startswith("ms-"):
            return {"ok": False, "error": "Key 必须以 ms- 开头"}
        with self._lock:
            if key in self._states:
                return {"ok": False, "error": "这把 Key 已存在"}
            self._states[key] = KeyState(key=key, masked=_mask(key))
        self._save_to_file()
        logger.info(f"已添加 Key: {_mask(key)}")
        return {"ok": True, "masked": _mask(key)}

    def remove_key(self, key: str) -> dict:
        """删除一把 Key（支持传完整 key 或 masked 形式匹配）"""
        with self._lock:
            # 精确匹配
            if key in self._states:
                del self._states[key]
                self._save_to_file()
                logger.info(f"已删除 Key: {_mask(key)}")
                return {"ok": True}
            # masked 匹配（如 ms-abc***xyz）
            for k, st in list(self._states.items()):
                if st.masked == key or k == key:
                    del self._states[k]
                    self._save_to_file()
                    logger.info(f"已删除 Key: {st.masked}")
                    return {"ok": True}
        return {"ok": False, "error": "未找到该 Key"}

    def update_key(self, old_key: str, new_key: str) -> dict:
        """更新一把 Key"""
        new_key = new_key.strip()
        if not new_key.startswith("ms-"):
            return {"ok": False, "error": "新 Key 必须以 ms- 开头"}
        with self._lock:
            # 精确匹配
            st = self._states.get(old_key)
            if not st:
                # masked 匹配
                for k, v in self._states.items():
                    if v.masked == old_key:
                        st = v
                        old_key = k
                        break
            if not st:
                return {"ok": False, "error": "未找到原 Key"}
            if new_key in self._states and new_key != old_key:
                return {"ok": False, "error": "新 Key 已存在"}
            # 保留统计，替换 key
            del self._states[old_key]
            st.key = new_key
            st.masked = _mask(new_key)
            self._states[new_key] = st
        self._save_to_file()
        logger.info(f"已更新 Key: {_mask(old_key)} → {_mask(new_key)}")
        return {"ok": True, "masked": _mask(new_key)}

    def get_all_keys(self) -> list[str]:
        """获取所有完整 Key 列表"""
        with self._lock:
            return list(self._states.keys())

    # ---------- 午夜重置 ----------

    def _start_midnight_reset_timer(self):
        def _run():
            while not self._stop_reset_timer.is_set():
                now = datetime.now()
                midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
                wait = (midnight - now).total_seconds()
                if self._stop_reset_timer.wait(timeout=wait + 1):
                    break
                self.reset_all_daily()
        t = threading.Thread(target=_run, daemon=True, name="midnight-reset")
        t.start()

    def reset_all_daily(self):
        with self._lock:
            for st in self._states.values():
                st.reset_daily()
        logger.info("===== 午夜重置：所有 Key 计数归零 =====")

    # ---------- Key 选择 ----------

    def select_key(self) -> KeyState | None:
        with self._lock:
            available = [st for st in self._states.values() if not st.is_exhausted and not st.is_cooling]
            if not available:
                return None
            return max(available, key=lambda s: DAILY_LIMIT - s.daily_count)

    def mark_used(self, key: str):
        with self._lock:
            st = self._states.get(key)
            if st:
                st.daily_count += 1
                st.total_requests += 1
                st.last_used = time.time()

    def mark_429(self, key: str, cooldown_seconds: float = 300):
        with self._lock:
            st = self._states.get(key)
            if st:
                st.cool(cooldown_seconds)
                st.total_429 += 1

    def mark_error(self, key: str):
        self.mark_429(key, cooldown_seconds=60)

    # ---------- 状态查询 ----------

    def get_all_status(self) -> list[dict]:
        with self._lock:
            result = []
            for st in self._states.values():
                result.append({
                    "key": st.key,
                    "masked": st.masked,
                    "daily_count": st.daily_count,
                    "daily_limit": DAILY_LIMIT,
                    "remaining": DAILY_LIMIT - st.daily_count,
                    "is_exhausted": st.is_exhausted,
                    "is_cooling": st.is_cooling,
                    "cooldown_remaining_s": round(st.cooldown_remaining, 1),
                    "total_requests": st.total_requests,
                    "total_429": st.total_429,
                })
            return result

    def available_count(self) -> int:
        with self._lock:
            return sum(1 for st in self._states.values() if not st.is_exhausted and not st.is_cooling)

    def shutdown(self):
        self._stop_reset_timer.set()
