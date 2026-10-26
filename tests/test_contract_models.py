"""所有生成模型拒绝 NaN / inf；时间须为 UTC 的校验只在 ContractModel 中（CD-07）。"""

import importlib
import inspect
import pkgutil

import pytest
from pydantic import BaseModel, RootModel

import py_contracts
from py_contracts.base import ContractModel


def generated_models() -> list[type[BaseModel]]:
    models = {
        obj
        for info in pkgutil.walk_packages(py_contracts.__path__, "py_contracts.")
        for _, obj in inspect.getmembers(importlib.import_module(info.name), inspect.isclass)
        if issubclass(obj, BaseModel) and obj.__module__ == info.name
    }
    return sorted(models, key=lambda m: f"{m.__module__}.{m.__name__}")


MODELS = generated_models()


def test_finds_root_models() -> None:
    assert any(issubclass(m, RootModel) for m in MODELS)


@pytest.mark.parametrize("model", MODELS, ids=lambda m: f"{m.__module__}.{m.__name__}")
def test_model_rejects_non_finite_number(model: type[BaseModel]) -> None:
    if issubclass(model, RootModel):
        assert model.model_config.get("allow_inf_nan") is False
        # RootModel 不经过 ContractModel 的 UTC 校验，不得包裹时间
        assert "datetime" not in str(model.model_fields["root"].annotation).lower()
    else:
        assert issubclass(model, ContractModel)
