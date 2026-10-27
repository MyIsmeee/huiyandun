"""CI-07 公网 URL 扫描（G-05、C-FE-01）。"""

import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "no_public_url.py"


def run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://cdn.jsdelivr.net/npm/three/build/three.module.js",
        "http://fonts.googleapis.com/css",
        "wss://api.openai.com/v1/realtime",
        "http://8.8.8.8/",
        "https://[2606:4700::1111]/",
        "//fonts.googleapis.com/css",
        "HTTPS://CDN.JSDELIVR.NET/npm/x",
        "https://token@cdn.jsdelivr.net/npm/x",
        "https://react.dev/learn",
        "https://tailwindcss.com/docs",
        "https://github.com/pmndrs/drei",
        "https://github.com/pmndrs/react-three-fiber/releases",
    ],
)
def test_reports_public_url(tmp_path: Path, url: str) -> None:
    (tmp_path / "app.ts").write_text(f"const a = 1;\nconst src = '{url}';\n")

    result = run(tmp_path, "app.ts")

    assert result.returncode == 1
    origin = "/".join(url.split("/")[:3])
    assert f"app.ts:2: {origin}" in result.stdout


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8080",
        "http://api-server:8000/api",
        "http://192.168.1.10:11434/v1",
        "http://10.0.0.5",
        "http://[::1]:9000",
        "https://203.0.113.5",
        "http://0.0.0.0:8000",
        "http://host.docker.internal:11434/v1",
        "http://nvr.local",
        "https://example.com/doc",
        "https://api.example.org",
        "https://${LLM_HOST}/v1",
        "http://{host}:{port}",
        "http://www.w3.org/2000/svg",
        "`https://react.dev/errors/`+e",
        "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */",
        "author:`Paul Henschel (https://github.com/drcmda)`",
        "homepage:`https://github.com/pmndrs/react-three-fiber#readme`",
        "See: https://docs.pmnd.rs/react-three-fiber/api/objects#x",
        "x  //cdn.vendor.io 不在引号或括号后",
    ],
)
def test_allows_internal_and_example_url(tmp_path: Path, url: str) -> None:
    (tmp_path / "config.yaml").write_text(f"base_url: {url}\n")

    result = run(tmp_path, "config.yaml")

    assert result.returncode == 0, result.stdout


@pytest.mark.parametrize(
    "name",
    ["uv.lock", "pnpm-lock.yaml", "README.md", ".github/workflows/ci.yml", "svc/tests/test_a.py"],
)
def test_skips_excluded_files(tmp_path: Path, name: str) -> None:
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("url = 'https://pypi.org/simple'\n")

    result = run(tmp_path, name)

    assert result.returncode == 0, result.stdout


def test_skips_binary_file(tmp_path: Path) -> None:
    (tmp_path / "logo.png").write_bytes(b"\x89PNG\0\0http://ns.adobe.com/xap/1.0/")

    assert run(tmp_path, "logo.png").returncode == 0


def test_scans_directory_recursively(tmp_path: Path) -> None:
    dist = tmp_path / "dist" / "assets"
    dist.mkdir(parents=True)
    (dist / "index.js").write_text("fetch('https://unpkg.com/x')")

    result = run(tmp_path, "dist")

    assert result.returncode == 1
    assert "dist/assets/index.js:1: https://unpkg.com" in result.stdout


def test_fails_on_missing_path(tmp_path: Path) -> None:
    result = run(tmp_path, "dist")

    assert result.returncode == 2
    assert "dist" in result.stderr


def test_defaults_to_git_files(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True, timeout=30)
    (tmp_path / ".gitignore").write_text("build/\n")
    (tmp_path / "build").mkdir()
    (tmp_path / "build" / "out.js").write_text("'https://unpkg.com/ignored'")
    (tmp_path / "main.py").write_text("URL = 'https://telemetry.vendor.io/collect'\n")

    result = run(tmp_path)

    assert result.returncode == 1
    assert "main.py:1: https://telemetry.vendor.io" in result.stdout
    assert "build/" not in result.stdout


def test_inert_text_is_allowed_only_in_explicit_paths(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True, timeout=30)
    (tmp_path / "app.ts").write_text("const doc = `https://react.dev/errors/`;\n")

    assert run(tmp_path, "app.ts").returncode == 0
    assert "app.ts:1: https://react.dev" in run(tmp_path).stdout
