"""
配置模块 —— 从 .env 加载配置，Key 列表优先从 keys.json 读取。
"""
import os
import json
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(BASE_DIR, "keys.json")


def _load_keys_from_json() -> list[str]:
    """从 keys.json 加载 Key 列表（含统计信息）"""
    if os.path.exists(KEYS_FILE):
        try:
            with open(KEYS_FILE) as f:
                data = json.load(f)
            keys = [item["key"] for item in data if item.get("key")]
            if keys:
                return keys
        except Exception:
            pass
    return []


def get_keys() -> list[str]:
    """
    返回所有 ModelScope API Key 列表。
    优先 keys.json，回退到 .env 的 MODELSCOPE_KEYS。
    """
    # 1. 先从 keys.json 加载
    keys = _load_keys_from_json()
    if keys:
        return keys

    # 2. 回退到 .env
    raw = os.getenv("MODELSCOPE_KEYS", "")
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    return keys


DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "200"))
PROXY_PORT = int(os.getenv("PROXY_PORT", "8000"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
MODELSCOPE_BASE_URL = os.getenv("MODELSCOPE_BASE_URL", "https://api-inference.modelscope.cn/v1")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "deepseek-ai/DeepSeek-V4-Pro")
