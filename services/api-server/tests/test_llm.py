"""供应商的网络位置判定、地址纠正与 Key 加密（C-LLM-13、C-ST-03、D-084）。"""

import base64
import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from api_server import llm

KEY = "sk-not-a-real-key-7f3a"


@pytest.fixture
def key_file(tmp_path: Path) -> Path:
    path = tmp_path / "llm_key_secret"
    path.write_text(base64.b64encode(os.urandom(32)).decode())
    return path


@pytest.mark.ci11
@pytest.mark.parametrize(
    ("url", "network"),
    [
        ("http://127.0.0.1:8080/v1", "internal"),
        ("http://[::1]:8080/v1", "internal"),
        ("http://10.1.2.3/v1", "internal"),
        ("http://172.16.0.9/v1", "internal"),
        ("http://172.31.255.1/v1", "internal"),
        ("http://192.168.1.50:8888/v1", "internal"),
        ("http://[fd00::5]/v1", "internal"),
        ("http://169.254.1.1/v1", "internal"),
        ("http://[fe80::1]/v1", "internal"),
        ("http://172.32.0.1/v1", "public"),
        ("http://100.64.0.1/v1", "public"),
        ("http://8.8.8.8/v1", "public"),
        ("http://localhost:8080/v1", "public"),
        ("http://host.docker.internal:8080/v1", "public"),
        ("https://api.deepseek.com/v1", "public"),
    ],
)
def test_network_by_address(url: str, network: str) -> None:
    """C-LLM-13：只认地址，域名一律公网（含 localhost）。"""
    assert llm.classify(url) == network


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.50:8888/v1/chat/completions/",
        "http://192.168.1.50:8888/v1/models",
        " http://192.168.1.50:8888/v1/ ",
    ],
)
def test_pasted_endpoint_trimmed_to_base_url(url: str) -> None:
    """D-084：去掉末尾斜杠与误粘贴的接口路径。"""
    assert llm.normalize(url) == "http://192.168.1.50:8888/v1"


@pytest.mark.parametrize("url", ["192.168.1.50:8888/v1", "ftp://10.0.0.1/v1", "http:///v1"])
def test_non_http_url_rejected(url: str) -> None:
    with pytest.raises(HTTPException) as e:
        llm.normalize(url)
    assert e.value.status_code == 400


def test_api_key_sealed_with_random_nonce(key_file: Path) -> None:
    """C-ST-03：AES-256-GCM，密文不含明文，同一 Key 两次加密结果不同，可解密还原。"""
    a, b = llm.seal(key_file, KEY), llm.seal(key_file, KEY)
    assert KEY.encode() not in a and a != b
    assert llm.unseal(key_file, a) == llm.unseal(key_file, b) == KEY


def test_key_columns_keep_last4_and_clear_on_empty(key_file: Path) -> None:
    columns = llm.key_columns(key_file, KEY)
    assert columns["api_key_last4"] == "7f3a"
    assert llm.unseal(key_file, columns["api_key_enc"]) == KEY
    assert llm.key_columns(key_file, "") == {"api_key_enc": None, "api_key_last4": None}


def test_key_file_must_hold_32_bytes(tmp_path: Path) -> None:
    short = tmp_path / "short"
    short.write_text(base64.b64encode(os.urandom(16)).decode())
    with pytest.raises(ValueError, match="32"):
        llm.seal(short, KEY)
